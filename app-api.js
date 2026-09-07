// ============================================================
//  TEZ LAW P.C. — MOBILE APP JSON API
//  ─────────────────────────────────────────────────────────
//  All endpoints for the native iOS "Zara" app live here.
//  Called from React Native (Expo) via /api/* routes.
//
//  Auth model:
//   • Staff/attorneys/consultants: Bearer JWT
//   • Clients: SMS OTP → issues client-scoped Bearer JWT
//
//  Data visibility model:
//   • admin role: sees everything
//   • attorney/paralegal/viewer: only tasks assigned to them,
//     plus clients / hearings / deadlines / notes that touch
//     those tasks. Anything else → filtered out or 403.
//   • consultant: only their own submitted work orders.
//   • client: only their own case data.
//
//  Response format:
//   Success: { ok: true, ...payload }
//   Error:   { ok: false, error: "message" } with 4xx/5xx status
// ============================================================

const crypto = require("crypto");
const db = require("./db");
const push = require("./push-notifications");
const auth = require("./auth");

// ── Utilities ─────────────────────────────────────────────

function extractToken(req) {
  const h = req.get("authorization") || req.get("Authorization") || "";
  if (h.startsWith("Bearer ")) return h.substring(7).trim();
  const cookies = auth.parseCookies(req);
  return cookies[auth.COOKIE_NAME] || null;
}

async function requireBearer(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ ok: false, error: "Missing token" });
    const payload = await auth.verifyToken(token);
    if (!payload) return res.status(401).json({ ok: false, error: "Invalid or expired token" });
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: err.message });
  }
}

function requireFirmUser(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "Auth required" });
  const r = req.user.r;
  if (!["admin", "manager", "attorney", "paralegal", "viewer"].includes(r)) {
    return res.status(403).json({ ok: false, error: "Firm role required" });
  }
  next();
}

function requireConsultantRole(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "Auth required" });
  if (req.user.r !== "consultant" && req.user.r !== "admin") {
    return res.status(403).json({ ok: false, error: "Consultant role required" });
  }
  next();
}

function requireClient(req, res, next) {
  if (!req.user || req.user.r !== "client") {
    return res.status(403).json({ ok: false, error: "Client role required" });
  }
  next();
}

// ═══════════════════════════════════════════════════════
//  ROLE-BASED VISIBILITY HELPERS
//  ────────────────────────────────────────────────────
//  Only admins see everything. All other firm users see
//  only what's assigned to them and the client data touching
//  those assignments.
// ═══════════════════════════════════════════════════════

function isAdmin(user) {
  return !!user && user.r === "admin";
}

function isManager(user) {
  return !!user && (user.r === "manager" || user.r === "admin");
}

// Terms to match against tasks.assigned_to (which is free text —
// could be username, full name, first name, or email).
function userAssignmentTerms(user) {
  const t = [];
  if (user?.u) t.push(String(user.u).toLowerCase().trim());
  if (user?.n) t.push(String(user.n).toLowerCase().trim());
  if (user?.n && String(user.n).includes(" ")) {
    t.push(String(user.n).split(" ")[0].toLowerCase().trim());
  }
  // Strip email domain if username is an email
  if (user?.u && String(user.u).includes("@")) {
    t.push(String(user.u).split("@")[0].toLowerCase().trim());
  }
  return Array.from(new Set(t.filter(Boolean)));
}

// True if this firm user is authorized to see this task.
function canUserSeeTask(user, task) {
  if (!task) return false;
  if (isManager(user)) return true;

  // Pending-approval tasks (from consultants) are hidden from firm assignees
  // until the admin approves. The consultant who submitted still sees their
  // own via the /api/consultant/* endpoints (this function is for firm side).
  if (task.status === "pending_approval") {
    // Only the person who created it (a consultant, but firm creators too) sees it
    if (task.created_by && String(task.created_by) === String(user.uid)) return true;
    if (task.submitted_by_user_id && String(task.submitted_by_user_id) === String(user.uid)) return true;
    return false;
  }

  if (task.created_by && String(task.created_by) === String(user.uid)) return true;
  if (task.submitted_by_user_id && String(task.submitted_by_user_id) === String(user.uid)) return true;
  const assigned = String(task.assigned_to || "").toLowerCase().trim();
  if (!assigned) return false;
  const terms = userAssignmentTerms(user);
  return terms.some(t => t && assigned.includes(t));
}

// Returns Set<string> of client_keys the user can access,
// or null for admin (meaning: no filtering — see all).
async function getVisibleClientKeys(user) {
  if (isManager(user)) return null;  // admin + manager see all
  const terms = userAssignmentTerms(user);
  const params = [String(user.uid)];
  let nameClause = "";
  if (terms.length) {
    const conds = terms.map((_, i) => `LOWER(assigned_to) LIKE $${i + 2}`);
    nameClause = " OR " + conds.join(" OR ");
    for (const t of terms) params.push(`%${t}%`);
  }
  try {
    const q = `
      SELECT DISTINCT client_key FROM tasks
      WHERE client_key IS NOT NULL
        AND (created_by::text = $1 OR submitted_by_user_id::text = $1${nameClause})
    `;
    const r = await db.query(q, params);
    return new Set(r.rows.map(row => row.client_key).filter(Boolean));
  } catch (e) {
    console.warn("[visibility] getVisibleClientKeys:", e.message);
    return new Set();
  }
}

// True if the user can access rows for this client_key.
async function canUserAccessClient(user, clientKey) {
  if (isManager(user)) return true;  // admin + manager see all clients
  if (!clientKey) return false;
  const keys = await getVisibleClientKeys(user);
  return keys.has(clientKey);
}

// Filters items by client_key membership. Null keys → passthrough (admin).
// Items without client_key are dropped for non-admin (safer default).
function filterByClientKeys(items, keys, keyField = "client_key") {
  if (keys === null) return items;
  return items.filter(item => {
    const k = item?.[keyField];
    if (!k) return false;
    return keys.has(k);
  });
}

// ── Client SMS-OTP auth (separate from staff) ────────────────

async function initClientAuthTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_otp (
      id           SERIAL PRIMARY KEY,
      phone        TEXT NOT NULL,
      code_hash    TEXT NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      attempts     INTEGER DEFAULT 0,
      used         BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_otp_phone ON client_otp (phone, expires_at DESC)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_accounts (
      id             SERIAL PRIMARY KEY,
      phone          TEXT UNIQUE NOT NULL,
      client_key     TEXT,
      full_name      TEXT,
      email          TEXT,
      preferred_lang TEXT DEFAULT 'en',
      last_login_at  TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_accounts_phone ON client_accounts (phone)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_accounts_key ON client_accounts (client_key)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id           SERIAL PRIMARY KEY,
      user_kind    TEXT NOT NULL,
      user_ref     TEXT NOT NULL,
      expo_token   TEXT NOT NULL UNIQUE,
      platform     TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_messages (
      id            SERIAL PRIMARY KEY,
      client_key    TEXT NOT NULL,
      sender_kind   TEXT NOT NULL,
      sender_name   TEXT,
      sender_id     INTEGER,
      sender_role   TEXT,
      body          TEXT NOT NULL,
      read_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Backfill for existing tables missing sender_role
  await db.query(`ALTER TABLE client_messages ADD COLUMN IF NOT EXISTS sender_role TEXT`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_messages_key ON client_messages (client_key, created_at DESC)`);

  // Matter-type default assignment table — determines auto-assignee when
  // a task is created without an explicit assignee.
  await db.query(`
    CREATE TABLE IF NOT EXISTS matter_defaults (
      matter_type   TEXT PRIMARY KEY,
      assigned_to   TEXT NOT NULL,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Seed defaults ONLY if the row doesn't already exist — never overwrite admin edits
  const seeds = [
    ['immigration', 'Michael Liu'],
    ['pi',          'Lin Mei'],
    ['business',    'Chandler Jin'],
    ['tm',          'Chandler Jin'],
    ['ll_tenant',   'JJ Zhang'],
    ['estate',      'JJ Zhang'],
    ['real_estate', 'JJ Zhang'],
    ['admin',       'JJ Zhang'],
  ];
  for (const [matter, assignee] of seeds) {
    await db.query(
      `INSERT INTO matter_defaults (matter_type, assigned_to) VALUES ($1, $2)
       ON CONFLICT (matter_type) DO NOTHING`,
      [matter, assignee]
    );
  }

  // Quick-reply templates for firm messaging
  await db.query(`
    CREATE TABLE IF NOT EXISTS quick_reply_templates (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      body         TEXT NOT NULL,
      category     TEXT DEFAULT 'general',
      created_by   INTEGER,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Seed common Tez Law templates only if the table is empty
  const tplCount = await db.query(`SELECT COUNT(*)::int AS n FROM quick_reply_templates`);
  if (tplCount.rows[0].n === 0) {
    const templates = [
      ['Received', "Thanks for your message. We've received it and will get back to you within 1 business day.", 'general'],
      ['Consultation booked', 'Your consultation is booked. Please arrive 10 minutes early with a photo ID. Our office is at 1050 Lakes Dr Ste 225, West Covina, CA 91790.', 'scheduling'],
      ['Docs needed', 'To move your case forward, please send us: (1) passport bio page, (2) any prior USCIS notices, (3) proof of current status. You can upload directly in the app or email jj@tezlawfirm.com.', 'immigration'],
      ['Hearing reminder', 'Reminder: your hearing is coming up. Please plan to arrive at the courthouse 30 minutes early with your ID and any documents we discussed. Business attire required.', 'immigration'],
      ['USCIS receipt', 'Your USCIS receipt number is on file. You can check status anytime via the app or at egov.uscis.gov/casestatus.', 'immigration'],
      ['Settlement update', 'We have an update on your settlement negotiation. Please schedule a call so we can walk through the details together.', 'pi'],
      ['Medical records', 'We need your medical records from [provider name] for your PI case. We can send a records request on your behalf — please confirm the provider name and dates of treatment.', 'pi'],
      ['Retainer signed', 'Thanks for signing the retainer. Your case is now officially open. Your case manager is [name] and will be your primary point of contact.', 'general'],
      ['Payment received', 'Payment received. Thank you. A receipt has been emailed to you.', 'billing'],
      ['Case closed', 'Your case is now closed. Thank you for trusting Tez Law. If you need us again in the future, please reach out anytime.', 'general'],
    ];
    for (const [name, body, category] of templates) {
      await db.query(
        `INSERT INTO quick_reply_templates (name, body, category) VALUES ($1, $2, $3)`,
        [name, body, category]
      );
    }
  }

  // Client-uploaded documents
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_documents (
      id            SERIAL PRIMARY KEY,
      client_key    TEXT NOT NULL,
      client_id     INTEGER,
      filename      TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER,
      category      TEXT DEFAULT 'other',
      note          TEXT,
      content       BYTEA NOT NULL,
      uploaded_by   TEXT DEFAULT 'client',
      uploaded_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_documents_key ON client_documents (client_key)`);

  // Client invoices — for the multi-method billing flow (Zelle, check, credit card link)
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_invoices (
      id                   SERIAL PRIMARY KEY,
      client_key           TEXT NOT NULL,
      description          TEXT NOT NULL,
      amount_cents         INTEGER NOT NULL,
      due_date             DATE,
      notes                TEXT,
      credit_card_link     TEXT,
      status               TEXT NOT NULL DEFAULT 'sent',
      paid_at              TIMESTAMPTZ,
      paid_method          TEXT,
      paid_note            TEXT,
      client_claim_paid_at TIMESTAMPTZ,
      client_claim_note    TEXT,
      created_by           INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_invoices_key ON client_invoices (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_invoices_status ON client_invoices (status)`);

  // Time tracking — billable and non-billable time entries
  await db.query(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id                SERIAL PRIMARY KEY,
      client_key        TEXT,
      task_id           INTEGER,
      staff_id          INTEGER NOT NULL,
      description       TEXT NOT NULL,
      minutes           INTEGER,
      hourly_rate_cents INTEGER,
      entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,
      billable          BOOLEAN DEFAULT TRUE,
      invoice_id        INTEGER,
      started_at        TIMESTAMPTZ,
      ended_at          TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_time_entries_client ON time_entries (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_time_entries_staff ON time_entries (staff_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries (entry_date)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_time_entries_active ON time_entries (staff_id, ended_at) WHERE ended_at IS NULL`);

  // Client notes — private staff notes about clients (case strategy, personal context)
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_notes (
      id           SERIAL PRIMARY KEY,
      client_key   TEXT NOT NULL,
      author_id    INTEGER NOT NULL,
      body         TEXT NOT NULL,
      pinned       BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_notes_client ON client_notes (client_key)`);

  // ─── IOLTA / Client Trust Account (Cal. Rules of Prof. Conduct 1.15) ──
  // Every deposit + withdrawal is logged with a running balance snapshot.
  // Balance is validated at insert time — withdrawals cannot exceed current balance.
  await db.query(`
    CREATE TABLE IF NOT EXISTS trust_transactions (
      id                     SERIAL PRIMARY KEY,
      client_key             TEXT NOT NULL,
      staff_id               INTEGER NOT NULL,
      txn_type               TEXT NOT NULL CHECK (txn_type IN ('deposit', 'withdrawal')),
      category               TEXT,
      amount_cents           INTEGER NOT NULL CHECK (amount_cents > 0),
      description            TEXT NOT NULL,
      memo                   TEXT,
      reference_number       TEXT,
      transaction_date       DATE NOT NULL DEFAULT CURRENT_DATE,
      running_balance_cents  INTEGER NOT NULL,
      reversed_by_txn_id     INTEGER,
      created_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_trust_txn_client ON trust_transactions (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_trust_txn_date ON trust_transactions (transaction_date DESC)`);

  // ─── Matter Templates / Case Workflows ─────────────────────
  // A predefined workflow attached to a matter type. When JJ (or staff)
  // starts a new case, they pick a template and it creates all standard
  // tasks with proper due dates, priorities, and assignees.
  await db.query(`
    CREATE TABLE IF NOT EXISTS matter_templates (
      id            SERIAL PRIMARY KEY,
      matter_type   TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT,
      active        BOOLEAN DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS matter_template_tasks (
      id                       SERIAL PRIMARY KEY,
      template_id              INTEGER NOT NULL REFERENCES matter_templates(id) ON DELETE CASCADE,
      sort_order               INTEGER DEFAULT 0,
      description              TEXT NOT NULL,
      priority                 TEXT DEFAULT 'normal',
      due_offset_days          INTEGER,
      assign_via_matter_default BOOLEAN DEFAULT TRUE,
      assigned_to              TEXT,
      category                 TEXT,
      notes                    TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mtt_template ON matter_template_tasks (template_id)`);

  // ─── Branches / Office Locations ─────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS branches (
      id           SERIAL PRIMARY KEY,
      code         TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      address      TEXT,
      phone        TEXT,
      active       BOOLEAN DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add branch_id to admin_users if it doesn't exist
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'admin_users' AND column_name = 'branch_id') THEN
        ALTER TABLE admin_users ADD COLUMN branch_id INTEGER;
      END IF;
    END $$;
  `);
  // Seed 4 branches if empty
  const branchCount = await db.query(`SELECT COUNT(*)::int AS n FROM branches`);
  if (branchCount.rows[0].n === 0) {
    const branches = [
      { code: 'WC', name: 'West Covina', address: '4141 S Nogales St C102, West Covina, CA 91792', phone: '626-678-8677' },
      { code: 'RH', name: 'Rowland Heights', address: 'Rowland Heights, CA', phone: '626-678-8677' },
      { code: 'NY', name: 'Flushing NY', address: 'Flushing, Queens, NY', phone: '626-678-8677' },
      { code: 'GI', name: 'Global Ican', address: 'Nationwide / Virtual', phone: '626-678-8677' },
    ];
    for (const b of branches) {
      await db.query(
        `INSERT INTO branches (code, name, address, phone) VALUES ($1, $2, $3, $4)`,
        [b.code, b.name, b.address, b.phone]
      );
    }
  }

  // ─── Case Members / Riders ─────────────────────────────────
  // The main client (primary respondent) can have multiple family
  // members ("riders") attached: spouse, minor children, parents.
  // A search for any rider's name will find the parent case.
  await db.query(`
    CREATE TABLE IF NOT EXISTS case_members (
      id             SERIAL PRIMARY KEY,
      client_key     TEXT NOT NULL,
      full_name      TEXT NOT NULL,
      relationship   TEXT NOT NULL,  -- 'self' | 'spouse' | 'child' | 'parent' | 'sibling' | 'other'
      a_number       TEXT,
      dob            DATE,
      is_primary     BOOLEAN DEFAULT FALSE,
      notes          TEXT,
      added_by       INTEGER,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_case_members_key ON case_members (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_case_members_name ON case_members (LOWER(full_name))`);

  // ─── Client Aliases (for merged / renamed clients) ─────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_aliases (
      id                 SERIAL PRIMARY KEY,
      canonical_key      TEXT NOT NULL,
      alias_key          TEXT NOT NULL,
      alias_name         TEXT,
      merged_by          INTEGER,
      merged_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(alias_key)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_aliases_canonical ON client_aliases (canonical_key)`);

  // Seed a few common workflows if empty
  const mtplCount = await db.query(`SELECT COUNT(*)::int AS n FROM matter_templates`);
  if (mtplCount.rows[0].n === 0) {
    const seed = async (matter, name, description, tasks) => {
      const t = await db.query(
        `INSERT INTO matter_templates (matter_type, name, description) VALUES ($1, $2, $3) RETURNING id`,
        [matter, name, description]
      );
      const tid = t.rows[0].id;
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        await db.query(
          `INSERT INTO matter_template_tasks
             (template_id, sort_order, description, priority, due_offset_days, category, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tid, i, task.desc, task.priority || 'normal',
           task.offset ?? null, task.category || null, task.notes || null]
        );
      }
    };

    // Family-based immigration
    await seed('immigration', 'I-130 Family Petition',
      'Standard workflow for I-130 petition for immediate relative or preference category.',
      [
        { desc: 'Initial client intake — gather bio data, relationship evidence', offset: 3, priority: 'high', category: 'Intake' },
        { desc: 'Draft I-130 form + G-28', offset: 10, category: 'Preparation' },
        { desc: 'Client review + signatures', offset: 14, category: 'Preparation' },
        { desc: 'Compile evidence package (birth certs, marriage cert, photos, etc.)', offset: 21, category: 'Evidence' },
        { desc: 'File I-130 with USCIS + track receipt number', offset: 28, priority: 'high', category: 'Filing' },
        { desc: 'Follow up on receipt notice (~2-4 weeks after filing)', offset: 60, category: 'Follow-up' },
        { desc: 'Monitor case status monthly', offset: 90, category: 'Follow-up' },
        { desc: 'Prepare for RFE if issued', priority: 'high', category: 'Contingency', notes: 'Only activate if RFE arrives' },
      ]
    );

    // I-485 AOS
    await seed('immigration', 'I-485 Adjustment of Status',
      'Standard AOS workflow — often filed concurrently with I-130 or I-140.',
      [
        { desc: 'Confirm eligibility (visa bulletin current, no bars)', offset: 3, priority: 'high', category: 'Intake' },
        { desc: 'Gather biographic + medical + police clearance', offset: 14, category: 'Evidence' },
        { desc: 'Draft I-485, I-864 Affidavit of Support, I-765 (EAD), I-131 (AP)', offset: 21, category: 'Preparation' },
        { desc: 'Client review + signatures', offset: 28, category: 'Preparation' },
        { desc: 'File AOS packet with USCIS', offset: 35, priority: 'high', category: 'Filing' },
        { desc: 'Track biometrics appointment (~4-8 wks)', offset: 60, category: 'Follow-up' },
        { desc: 'Prep interview binder + client interview prep', offset: 180, priority: 'high', category: 'Interview' },
        { desc: 'Attend interview with client', offset: 240, priority: 'urgent', category: 'Interview' },
      ]
    );

    // N-400 Naturalization
    await seed('immigration', 'N-400 Naturalization',
      'Standard N-400 workflow through the oath ceremony.',
      [
        { desc: 'Confirm eligibility (5 yrs LPR, physical presence, good moral character)', offset: 3, priority: 'high', category: 'Intake' },
        { desc: 'Prepare N-400 application', offset: 14, category: 'Preparation' },
        { desc: 'Client civics + English study materials', offset: 21, category: 'Preparation' },
        { desc: 'File N-400 + track receipt', offset: 28, priority: 'high', category: 'Filing' },
        { desc: 'Biometrics appointment (~4 wks)', offset: 60, category: 'Follow-up' },
        { desc: 'Interview prep with client', offset: 120, priority: 'high', category: 'Interview' },
        { desc: 'Naturalization interview', offset: 150, priority: 'urgent', category: 'Interview' },
        { desc: 'Oath ceremony coordination', offset: 180, category: 'Ceremony' },
      ]
    );

    // Personal Injury
    await seed('pi', 'Personal Injury — Auto Accident',
      'Pre-litigation workflow through demand.',
      [
        { desc: 'Client intake — accident details, injuries, insurance info', offset: 1, priority: 'urgent', category: 'Intake' },
        { desc: 'Send LOR (Letter of Representation) to insurance carriers', offset: 3, priority: 'high', category: 'Notice' },
        { desc: 'Request police report, obtain medical records', offset: 14, category: 'Evidence' },
        { desc: 'Client medical treatment tracking (monthly)', offset: 30, category: 'Medical' },
        { desc: 'Photo documentation of injuries + vehicle damage', offset: 30, category: 'Evidence' },
        { desc: 'Follow up on medical records requests', offset: 60, category: 'Evidence' },
        { desc: 'Confirm max medical improvement (MMI) reached', offset: 180, category: 'Medical' },
        { desc: 'Compile damages summary + medical costs', offset: 200, category: 'Damages' },
        { desc: 'Draft + send demand letter', offset: 210, priority: 'high', category: 'Demand' },
        { desc: 'Follow up on demand (30 days)', offset: 240, category: 'Follow-up' },
        { desc: 'Evaluate settlement vs. filing suit', offset: 270, priority: 'high', category: 'Decision' },
      ]
    );

    // Business formation
    await seed('business', 'California LLC Formation',
      'Standard workflow for forming a new California LLC.',
      [
        { desc: 'Client intake — business name, member info, purpose', offset: 1, priority: 'high', category: 'Intake' },
        { desc: 'Name availability search + reservation', offset: 3, category: 'Preparation' },
        { desc: 'Draft Articles of Organization', offset: 7, category: 'Preparation' },
        { desc: 'File Articles with CA Secretary of State', offset: 10, priority: 'high', category: 'Filing' },
        { desc: 'Obtain EIN from IRS', offset: 14, category: 'Filing' },
        { desc: 'Draft Operating Agreement', offset: 21, category: 'Preparation' },
        { desc: 'Client execution of Operating Agreement', offset: 28, category: 'Execution' },
        { desc: 'File Statement of Information (within 90 days)', offset: 60, priority: 'high', category: 'Filing' },
        { desc: 'Reminder: annual $800 franchise tax due', offset: 365, category: 'Compliance', notes: 'Recurring annual obligation' },
      ]
    );
  }

  // ── Attorney Suite ─────────────────────────────────────────
  // Document templates (retainer, engagement letter, common motions)
  await db.query(`
    CREATE TABLE IF NOT EXISTS document_templates (
      id            SERIAL PRIMARY KEY,
      slug          TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      category      TEXT DEFAULT 'general',
      description   TEXT,
      body          TEXT NOT NULL,
      variables     JSONB DEFAULT '[]'::jsonb,
      created_by    INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_document_templates_category ON document_templates (category)`);
  // Seed with common templates if empty
  const tCount = await db.query(`SELECT COUNT(*)::int AS n FROM document_templates`);
  if (tCount.rows[0].n === 0) {
    const seedTemplates = [
      {
        slug: 'retainer-immigration',
        name: 'Retainer Agreement — Immigration',
        category: 'retainer',
        description: 'Standard retainer for immigration matters (petitions, applications, court)',
        body: `RETAINER AGREEMENT

This agreement is entered into on {today_date} between Tez Law P.C., a professional corporation ("Attorney"), and {client_name} ("Client").

1. SCOPE OF REPRESENTATION
Attorney agrees to represent Client in connection with the following matter:
{matter_description}

2. FEES
Client agrees to pay Attorney a fixed fee of \${fee_amount} for the scope of work described above. Payment is due as follows: {payment_schedule}.

Additional services outside the scope of this agreement (e.g., appeals, motions to reopen, or unrelated legal matters) will be billed separately at Attorney's standard hourly rate of \${hourly_rate}/hour.

3. COSTS AND EXPENSES
Client is responsible for all filing fees, biometrics fees, translation costs, medical exam fees, and other out-of-pocket costs. USCIS filing fees are payable directly to USCIS.

4. CLIENT'S OBLIGATIONS
Client agrees to:
(a) Provide truthful and complete information;
(b) Timely provide all requested documents;
(c) Notify Attorney promptly of any change in address, employment, marital status, or immigration status;
(d) Cooperate fully in the preparation and prosecution of the matter.

5. NO GUARANTEE
Attorney makes no guarantee regarding the outcome. USCIS, the Immigration Court, and other agencies make discretionary decisions that Attorney cannot control.

6. TERMINATION
Either party may terminate this agreement upon written notice. If Client terminates, earned fees are non-refundable.

Managing Attorney: JJ Zhang, California Bar #326666
Tez Law P.C. · 626-678-8677 · jj@tezlawfirm.com

Client signature: ______________________________  Date: _______________

Attorney signature: ______________________________  Date: _______________`,
        variables: [
          { key: 'client_name', label: 'Client Name', required: true },
          { key: 'matter_description', label: 'Matter Description', required: true, multiline: true, placeholder: 'e.g. Preparation and filing of Form I-130 Petition for Alien Relative for beneficiary [name]' },
          { key: 'fee_amount', label: 'Flat Fee (USD)', required: true, placeholder: '2500' },
          { key: 'payment_schedule', label: 'Payment Schedule', required: true, placeholder: '50% upon signing, 50% upon filing' },
          { key: 'hourly_rate', label: 'Hourly Rate (USD)', required: true, placeholder: '350' },
        ],
      },
      {
        slug: 'retainer-pi',
        name: 'Retainer Agreement — Personal Injury',
        category: 'retainer',
        description: 'Contingency-fee retainer for personal injury matters',
        body: `PERSONAL INJURY RETAINER AGREEMENT

This agreement is entered into on {today_date} between Tez Law P.C., a professional corporation ("Attorney"), and {client_name} ("Client").

1. SCOPE OF REPRESENTATION
Attorney agrees to represent Client in the personal injury claim arising from the incident that occurred on {incident_date} at {incident_location}.

2. CONTINGENCY FEE
Attorney's fee is contingent upon recovery. If no recovery, Client owes no attorney fee.
If recovery is obtained, Attorney shall receive:
- {pre_lit_pct}% of gross recovery obtained BEFORE filing a lawsuit
- {post_lit_pct}% of gross recovery obtained AFTER filing a lawsuit

3. COSTS AND EXPENSES
Attorney will advance case costs (records, filing fees, expert witnesses, etc.). Costs will be reimbursed from the recovery. If no recovery, Client is not responsible for advanced costs.

4. LIEN AUTHORIZATION
Client authorizes Attorney to satisfy medical bills, health insurance liens, and other liens from the recovery, and to pay Client the net balance.

5. CLIENT COOPERATION
Client agrees to attend all medical appointments, provide truthful and complete information, and cooperate in the prosecution of the claim.

6. NO GUARANTEE
Attorney makes no guarantee regarding recovery amount or timing.

Managing Attorney: JJ Zhang, California Bar #326666
Tez Law P.C. · 626-678-8677 · jj@tezlawfirm.com

Client signature: ______________________________  Date: _______________

Attorney signature: ______________________________  Date: _______________`,
        variables: [
          { key: 'client_name', label: 'Client Name', required: true },
          { key: 'incident_date', label: 'Date of Incident', required: true, placeholder: 'e.g. March 15, 2026' },
          { key: 'incident_location', label: 'Location of Incident', required: true, placeholder: 'e.g. Intersection of Grand Ave and Baseline Rd, Pomona CA' },
          { key: 'pre_lit_pct', label: 'Pre-litigation Fee %', required: true, placeholder: '33.33' },
          { key: 'post_lit_pct', label: 'Post-litigation Fee %', required: true, placeholder: '40' },
        ],
      },
      {
        slug: 'engagement-letter',
        name: 'Engagement Letter (Non-Retainer)',
        category: 'engagement',
        description: 'Short-form engagement letter confirming legal representation',
        body: `Date: {today_date}

Re: Engagement of Legal Services

Dear {client_name},

This letter confirms that Tez Law P.C. has been engaged to represent you in the following matter:
{matter_description}

Our fees for this matter are described in the retainer agreement executed on {retainer_date}. This engagement is limited to the scope described above; any additional services will require a separate engagement.

We appreciate the opportunity to serve you and look forward to a successful outcome. Please contact us at 626-678-8677 or jj@tezlawfirm.com with any questions.

Sincerely,

JJ Zhang
Managing Attorney
Tez Law P.C.
California Bar #326666`,
        variables: [
          { key: 'client_name', label: 'Client Name', required: true },
          { key: 'matter_description', label: 'Matter Description', required: true, multiline: true },
          { key: 'retainer_date', label: 'Retainer Date', required: true, placeholder: 'e.g. September 7, 2026' },
        ],
      },
      {
        slug: 'motion-continuance',
        name: 'Motion for Continuance — Immigration Court',
        category: 'motion',
        description: 'Motion to continue a scheduled hearing before the Immigration Court',
        body: `UNITED STATES DEPARTMENT OF JUSTICE
EXECUTIVE OFFICE FOR IMMIGRATION REVIEW
IMMIGRATION COURT
{court_location}

In the Matter of:                          )
                                           )
{client_name}                              )   File No.: {a_number}
                                           )
     Respondent.                           )   Next Hearing: {hearing_date}
                                           )

MOTION TO CONTINUE

Respondent, {client_name}, through undersigned counsel, respectfully moves this Honorable Court to continue the {hearing_type} currently scheduled for {hearing_date}, and states as follows:

1. Respondent is scheduled for a {hearing_type} on {hearing_date} at {hearing_time}.

2. A continuance is requested because: {reason_for_continuance}

3. Undersigned counsel has conferred with opposing counsel {opposing_counsel_position}.

4. This is Respondent's {continuance_number} request for continuance in this matter.

5. Good cause exists for this continuance because {good_cause_statement}

WHEREFORE, Respondent respectfully requests that the Court continue the {hearing_type} to a mutually convenient date.

Respectfully submitted this {today_date}.

_______________________________
JJ Zhang, Esq.
California Bar No. 326666
Tez Law P.C.
1050 Lakes Dr., Suite 225
West Covina, CA 91790
Tel: (626) 678-8677
Email: jj@tezlawfirm.com
Counsel for Respondent`,
        variables: [
          { key: 'court_location', label: 'Court Location', required: true, placeholder: 'e.g. LOS ANGELES, CALIFORNIA' },
          { key: 'client_name', label: 'Respondent Name', required: true },
          { key: 'a_number', label: 'A-Number', required: true, placeholder: 'A000-000-000' },
          { key: 'hearing_date', label: 'Current Hearing Date', required: true },
          { key: 'hearing_time', label: 'Hearing Time', required: true, placeholder: '9:00 AM' },
          { key: 'hearing_type', label: 'Hearing Type', required: true, placeholder: 'Individual Hearing / Master Calendar Hearing' },
          { key: 'reason_for_continuance', label: 'Reason for Continuance', required: true, multiline: true },
          { key: 'opposing_counsel_position', label: 'DHS Position', required: true, placeholder: 'and DHS does not oppose / and DHS opposes' },
          { key: 'continuance_number', label: 'Which continuance is this? (1st, 2nd, etc)', required: true, placeholder: 'first' },
          { key: 'good_cause_statement', label: 'Good Cause Statement', required: true, multiline: true },
        ],
      },
      {
        slug: 'demand-letter-pi',
        name: 'PI Demand Letter to Insurance',
        category: 'letter',
        description: 'Demand letter to insurance carrier for personal injury settlement',
        body: `{today_date}

VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED

{carrier_name}
Claims Department
{carrier_address}

Re:   Our Client:        {client_name}
      Date of Loss:      {incident_date}
      Your Insured:      {insured_name}
      Claim No.:         {claim_number}

Dear Claims Representative,

This firm represents {client_name} in connection with injuries sustained on {incident_date} as a result of the negligence of your insured, {insured_name}.

LIABILITY
{liability_summary}

INJURIES
As a direct and proximate result of your insured's negligence, our client suffered the following injuries:
{injuries_summary}

MEDICAL EXPENSES
To date, our client has incurred the following medical expenses:
{medical_expenses_summary}

Total Medical Specials: \${total_medicals}

LOST WAGES
{lost_wages_summary}

Total Lost Wages: \${total_lost_wages}

PAIN AND SUFFERING
{pain_suffering_summary}

DEMAND
Based on the foregoing, we hereby demand \${demand_amount} in full and final settlement of this claim. This demand will remain open for {demand_days} days from the date of this letter, after which we will file suit.

We look forward to your prompt response.

Sincerely,

JJ Zhang
Attorney at Law
California Bar No. 326666
Tez Law P.C.
Tel: (626) 678-8677`,
        variables: [
          { key: 'carrier_name', label: 'Insurance Carrier Name', required: true },
          { key: 'carrier_address', label: 'Carrier Address', required: true, multiline: true },
          { key: 'client_name', label: 'Client Name', required: true },
          { key: 'incident_date', label: 'Date of Loss', required: true },
          { key: 'insured_name', label: 'Insured (Defendant) Name', required: true },
          { key: 'claim_number', label: 'Claim Number', required: true },
          { key: 'liability_summary', label: 'Liability Summary', required: true, multiline: true },
          { key: 'injuries_summary', label: 'Injuries Summary', required: true, multiline: true },
          { key: 'medical_expenses_summary', label: 'Medical Expenses Detail', required: true, multiline: true },
          { key: 'total_medicals', label: 'Total Medical Bills (USD)', required: true, placeholder: '15000.00' },
          { key: 'lost_wages_summary', label: 'Lost Wages Summary', required: true, multiline: true },
          { key: 'total_lost_wages', label: 'Total Lost Wages (USD)', required: true, placeholder: '5000.00' },
          { key: 'pain_suffering_summary', label: 'Pain & Suffering Summary', required: true, multiline: true },
          { key: 'demand_amount', label: 'Demand Amount (USD)', required: true, placeholder: '75000.00' },
          { key: 'demand_days', label: 'Days for Response', required: true, placeholder: '30' },
        ],
      },
    ];
    for (const t of seedTemplates) {
      await db.query(
        `INSERT INTO document_templates (slug, name, category, description, body, variables)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [t.slug, t.name, t.category, t.description, t.body, JSON.stringify(t.variables)]
      );
    }
  }

  // Generated documents (finalized instances of templates)
  await db.query(`
    CREATE TABLE IF NOT EXISTS generated_documents (
      id            SERIAL PRIMARY KEY,
      client_key    TEXT,
      template_slug TEXT,
      template_name TEXT,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL,
      variables     JSONB DEFAULT '{}'::jsonb,
      generated_by  INTEGER NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_generated_documents_client ON generated_documents (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_generated_documents_author ON generated_documents (generated_by)`);

  // CLE credits (per-attorney)
  await db.query(`
    CREATE TABLE IF NOT EXISTS cle_credits (
      id                SERIAL PRIMARY KEY,
      attorney_id       INTEGER NOT NULL,
      provider          TEXT NOT NULL,
      subject           TEXT NOT NULL,
      hours             NUMERIC(5,2) NOT NULL,
      ethics_hours      NUMERIC(5,2) DEFAULT 0,
      competence_hours  NUMERIC(5,2) DEFAULT 0,
      bias_hours        NUMERIC(5,2) DEFAULT 0,
      tech_hours        NUMERIC(5,2) DEFAULT 0,
      credit_date       DATE NOT NULL,
      compliance_period TEXT,
      notes             TEXT,
      certificate_url   TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cle_credits_attorney ON cle_credits (attorney_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cle_credits_date ON cle_credits (credit_date)`);

  // Court prep checklists (one per task, task must be a court date)
  await db.query(`
    CREATE TABLE IF NOT EXISTS court_prep_items (
      id          SERIAL PRIMARY KEY,
      task_id     INTEGER NOT NULL,
      item_text   TEXT NOT NULL,
      completed   BOOLEAN DEFAULT FALSE,
      position    INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_court_prep_task ON court_prep_items (task_id)`);

  // ── Consultant Assignments ─────────────────────────
  // Admins assign consultants to specific clients. Consultants only see
  // clients they're actively assigned to. Removing an assignment cuts off
  // their access immediately (soft delete — firm retains all data).
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_consultants (
      id                  SERIAL PRIMARY KEY,
      client_key          TEXT NOT NULL,
      consultant_id       INTEGER NOT NULL,
      role_description    TEXT,
      assigned_by         INTEGER,
      assigned_at         TIMESTAMPTZ DEFAULT NOW(),
      removed_at          TIMESTAMPTZ,
      removed_by          INTEGER,
      removal_reason      TEXT,
      notes               TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_consultants_client ON client_consultants (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_consultants_consultant ON client_consultants (consultant_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_consultants_active ON client_consultants (consultant_id, removed_at) WHERE removed_at IS NULL`);

  // ── Document E-Signatures ──────────────────────────
  // For documents generated from templates and sent to clients to sign
  // (via SMS or email). Public sign URL is /sign/:token
  await db.query(`
    CREATE TABLE IF NOT EXISTS document_signatures (
      id                    SERIAL PRIMARY KEY,
      generated_document_id INTEGER NOT NULL,
      sign_token            TEXT UNIQUE NOT NULL,
      recipient_email       TEXT,
      recipient_phone       TEXT,
      recipient_name        TEXT,
      sent_by               INTEGER NOT NULL,
      sent_via              TEXT,
      sent_at               TIMESTAMPTZ DEFAULT NOW(),
      expires_at            TIMESTAMPTZ,
      signed_at             TIMESTAMPTZ,
      signed_by_name        TEXT,
      signature_data        TEXT,
      signer_ip             TEXT,
      signer_user_agent     TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_document_signatures_token ON document_signatures (sign_token)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_document_signatures_doc ON document_signatures (generated_document_id)`);
}

// In-memory cache of matter defaults. Reloaded on any admin update.
let _matterDefaultsCache = null;
async function getDefaultAssignee(matterType) {
  if (!matterType) return null;
  if (!_matterDefaultsCache) {
    try {
      const r = await db.query(`SELECT matter_type, assigned_to FROM matter_defaults`);
      _matterDefaultsCache = {};
      for (const row of r.rows) _matterDefaultsCache[row.matter_type] = row.assigned_to;
    } catch (e) {
      console.warn("[matter defaults] cache load:", e.message);
      _matterDefaultsCache = {};
    }
  }
  return _matterDefaultsCache[matterType] || null;
}
function invalidateMatterDefaultsCache() { _matterDefaultsCache = null; }

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.startsWith("1") && digits.length > 10) return "+" + digits;
  return "+" + digits;
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

async function issueClientToken(account) {
  return await auth.makeToken({
    uid: `c${account.id}`,
    u: account.phone,
    n: account.full_name || account.phone,
    r: "client",
    ck: account.client_key || null,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

// ─────────────────────────────────────────────────────────
// Route registration — call registerAppApi(app) from server.js
// ─────────────────────────────────────────────────────────
function registerAppApi(app) {
  initClientAuthTables().catch(e => console.warn("[app-api] init:", e.message));

  // ═══════════════════════════════════════════════════════
  //  AUTH
  // ═══════════════════════════════════════════════════════

  app.post("/api/auth/staff/login", async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ ok: false, error: "username and password required" });
      const user = await auth.findUserByUsername(String(username).toLowerCase().trim());
      if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });
      // Schema uses `disabled` (boolean) — legacy code checked `active` which doesn't exist
      if (user.disabled === true) return res.status(403).json({ ok: false, error: "Account disabled" });
      const ok = await auth.verifyPasswordHash(password, user.password_hash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });
      const token = await auth.makeToken({
        uid: user.id, u: user.username, n: user.full_name, r: user.role,
        exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });
      await auth.updateLastLogin(user.id);
      const perms = typeof auth.getEffectivePermissions === "function"
        ? await auth.getEffectivePermissions(user)
        : (typeof auth.getPermissions === "function" ? auth.getPermissions(user) : {});
      res.json({
        ok: true,
        token,
        user: {
          id: user.id, username: user.username, name: user.full_name, role: user.role,
          role_label: (auth.ROLES?.[user.role]?.label) || user.role,
          permissions: perms,
          is_admin: user.role === "admin",
        },
      });
    } catch (err) {
      console.error("[api staff login]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/auth/client/request-otp", async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!phone) return res.status(400).json({ ok: false, error: "Valid phone required" });
      const recent = await db.query(
        `SELECT COUNT(*)::int AS n FROM client_otp WHERE phone = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
        [phone]
      );
      if (recent.rows[0].n >= 3) {
        return res.status(429).json({ ok: false, error: "Too many attempts, please try again in 15 minutes" });
      }
      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioToken = process.env.TWILIO_AUTH_TOKEN;
      const verifyServiceSid = process.env.TWILIO_VERIFY_SID;
      const twilioFrom = process.env.TWILIO_SMS_FROM || process.env.TWILIO_PHONE_NUMBER;

      // Path A (preferred): Twilio Verify service — uses A2P-registered shared pool,
      // generates+delivers+stores the code itself. No local hashing.
      if (twilioSid && twilioToken && verifyServiceSid) {
        try {
          const axios = require("axios");
          // Twilio locale codes for the SMS body: en, es, zh (Simplified), zh-HK (Traditional)
          const langRaw = String(req.body?.lang || "en").toLowerCase();
          let locale = "en";
          if (langRaw === "es" || langRaw.startsWith("es-")) locale = "es";
          else if (langRaw === "zh-tw" || langRaw === "zh-hk" || langRaw === "zh-hant") locale = "zh-HK";
          else if (langRaw === "zh" || langRaw === "zh-cn" || langRaw === "zh-hans") locale = "zh";
          await axios.post(
            `https://verify.twilio.com/v2/Services/${verifyServiceSid}/Verifications`,
            new URLSearchParams({ To: phone, Channel: "sms", Locale: locale }).toString(),
            { auth: { username: twilioSid, password: twilioToken },
              headers: { "Content-Type": "application/x-www-form-urlencoded" } }
          );
          // Insert a marker row so the verify endpoint knows to use Verify (not local hash).
          // The code_hash "verify" is a sentinel — never a real hash.
          await db.query(
            `INSERT INTO client_otp (phone, code_hash, expires_at) VALUES ($1, 'verify', NOW() + INTERVAL '10 minutes')`,
            [phone]
          );
          return res.json({ ok: true, message: "Verification code sent" });
        } catch (twErr) {
          console.error("[client OTP verify]:", twErr.response?.data || twErr.message);
          return res.status(500).json({ ok: false, error: "Failed to send code" });
        }
      }

      // Path B (fallback): raw SMS from a specific number. Requires A2P 10DLC registration
      // on that number, or delivery fails with error 30034.
      const code = String(crypto.randomInt(100000, 999999));
      const codeHash = hashCode(code);
      await db.query(
        `INSERT INTO client_otp (phone, code_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
        [phone, codeHash]
      );
      if (twilioSid && twilioToken && twilioFrom) {
        try {
          const axios = require("axios");
          await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
            new URLSearchParams({
              To: phone, From: twilioFrom,
              Body: `Your Tez Law verification code is ${code}. Expires in 10 minutes. Do not share this code.`,
            }).toString(),
            { auth: { username: twilioSid, password: twilioToken }, headers: { "Content-Type": "application/x-www-form-urlencoded" } }
          );
        } catch (twErr) {
          console.error("[client OTP twilio]:", twErr.response?.data || twErr.message);
          return res.status(500).json({ ok: false, error: "Failed to send SMS" });
        }
      } else {
        console.warn(`[DEV] Client OTP for ${phone}: ${code}`);
      }
      res.json({ ok: true, message: "Verification code sent" });
    } catch (err) {
      console.error("[api client request-otp]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/auth/client/verify-otp", async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      const code = String(req.body?.code || "").trim();
      if (!phone || !code) return res.status(400).json({ ok: false, error: "Phone and code required" });
      const r = await db.query(
        `SELECT * FROM client_otp
         WHERE phone = $1 AND used = FALSE AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [phone]
      );
      const otp = r.rows[0];
      if (!otp) return res.status(400).json({ ok: false, error: "Code expired — request a new one" });
      if (otp.attempts >= 5) {
        return res.status(429).json({ ok: false, error: "Too many attempts. Request a new code." });
      }

      // If marked "verify" the code was delivered by Twilio Verify — check with them.
      // Otherwise it was our local hash flow (dev/fallback).
      let codeValid = false;
      if (otp.code_hash === "verify") {
        const twilioSid = process.env.TWILIO_ACCOUNT_SID;
        const twilioToken = process.env.TWILIO_AUTH_TOKEN;
        const verifyServiceSid = process.env.TWILIO_VERIFY_SID;
        if (!twilioSid || !twilioToken || !verifyServiceSid) {
          return res.status(500).json({ ok: false, error: "Verify not configured" });
        }
        try {
          const axios = require("axios");
          const vRes = await axios.post(
            `https://verify.twilio.com/v2/Services/${verifyServiceSid}/VerificationCheck`,
            new URLSearchParams({ To: phone, Code: code }).toString(),
            { auth: { username: twilioSid, password: twilioToken },
              headers: { "Content-Type": "application/x-www-form-urlencoded" } }
          );
          codeValid = vRes.data?.status === "approved";
        } catch (twErr) {
          console.error("[verify check]:", twErr.response?.data || twErr.message);
          await db.query(`UPDATE client_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
          return res.status(401).json({ ok: false, error: "Incorrect code" });
        }
      } else {
        codeValid = hashCode(code) === otp.code_hash;
      }

      if (!codeValid) {
        await db.query(`UPDATE client_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
        return res.status(401).json({ ok: false, error: "Incorrect code" });
      }
      await db.query(`UPDATE client_otp SET used = TRUE WHERE id = $1`, [otp.id]);
      let accountR = await db.query(`SELECT * FROM client_accounts WHERE phone = $1`, [phone]);
      let account = accountR.rows[0];
      if (!account) {
        let clientKey = null, clientName = null;
        try {
          const cr = await db.query(
            `SELECT DISTINCT client_key, client_name FROM client_hearing_notices
             WHERE phone_number = $1 OR phone = $1
             ORDER BY client_name ASC LIMIT 1`,
            [phone]
          ).catch(() => ({ rows: [] }));
          if (cr.rows.length) {
            clientKey = cr.rows[0].client_key;
            clientName = cr.rows[0].client_name;
          }
        } catch {}
        const ins = await db.query(
          `INSERT INTO client_accounts (phone, client_key, full_name) VALUES ($1, $2, $3) RETURNING *`,
          [phone, clientKey, clientName]
        );
        account = ins.rows[0];
      }
      await db.query(`UPDATE client_accounts SET last_login_at = NOW() WHERE id = $1`, [account.id]);
      const token = await issueClientToken(account);
      res.json({
        ok: true,
        token,
        user: {
          id: `c${account.id}`,
          phone: account.phone,
          name: account.full_name,
          role: "client",
          client_key: account.client_key,
          preferred_lang: account.preferred_lang || "en",
          linked_to_case: !!account.client_key,
        },
      });
    } catch (err) {
      console.error("[api client verify-otp]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/me", requireBearer, async (req, res) => {
    res.json({
      ok: true,
      user: {
        id: req.user.uid, username: req.user.u, name: req.user.n,
        role: req.user.r, client_key: req.user.ck || null,
        is_admin: req.user.r === "admin",
      },
    });
  });

  // ═══════════════════════════════════════════════════════
  //  PUSH NOTIFICATION TOKENS
  // ═══════════════════════════════════════════════════════

  app.post("/api/push/register", requireBearer, async (req, res) => {
    try {
      const { token, platform } = req.body || {};
      if (!token) return res.status(400).json({ ok: false, error: "token required" });
      const userKind = req.user.r === "client" ? "client"
        : req.user.r === "consultant" ? "consultant"
        : "staff";
      const userRef = String(req.user.uid);
      await db.query(
        `INSERT INTO push_tokens (user_kind, user_ref, expo_token, platform)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (expo_token) DO UPDATE SET user_kind = EXCLUDED.user_kind,
           user_ref = EXCLUDED.user_ref, platform = EXCLUDED.platform, updated_at = NOW()`,
        [userKind, userRef, token, platform || "ios"]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/push/unregister", requireBearer, async (req, res) => {
    try {
      const { token } = req.body || {};
      if (token) await db.query(`DELETE FROM push_tokens WHERE expo_token = $1`, [token]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  STAFF: DASHBOARD, TASKS, CALENDAR, CLIENTS, NOTES
  //  (visibility-filtered per role)
  // ═══════════════════════════════════════════════════════

  // Consolidated dashboard summary
  app.get("/api/staff/dashboard", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const today = new Date().toISOString().split("T")[0];
      const nextWeek = new Date(Date.now() + 7 * 86400e3).toISOString().split("T")[0];

      const visibleKeys = await getVisibleClientKeys(req.user);
      const admin = isAdmin(req.user);

      const [allOpenTasks, allHearings, allDeadlines, unnotifiedAll] = await Promise.all([
        // Wider limit so we don't miss visible tasks after filtering
        tasks.listTasks({ due_within_days: 30, limit: admin ? 200 : 1000 }),
        db.query(
          `SELECT id, client_key, client_name, a_number, hearing_date, hearing_type, court_name
           FROM client_hearing_notices WHERE hearing_date >= $1 AND hearing_date <= $2 AND dismissed_at IS NULL
           ORDER BY hearing_date ASC LIMIT 200`, [today, nextWeek]
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT id, description, due_date, priority, client_key, client_name, source_type
           FROM deadlines WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '14 days'
           ORDER BY due_date ASC LIMIT 200`
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT client_key FROM client_hearing_notices
           WHERE is_hearing_notice = TRUE AND dismissed_at IS NULL AND notified_at IS NULL`
        ).then(r => r.rows).catch(() => []),
      ]);

      // Apply visibility filters
      const openTasks = admin ? allOpenTasks : allOpenTasks.filter(t => canUserSeeTask(req.user, t));
      const hearings = filterByClientKeys(allHearings, visibleKeys);
      const deadlines = filterByClientKeys(allDeadlines, visibleKeys);
      const unnotifiedCount = admin
        ? unnotifiedAll.length
        : filterByClientKeys(unnotifiedAll, visibleKeys).length;

      const stats = { due_today: 0, overdue: 0, urgent: 0, total_open: openTasks.length };
      for (const t of openTasks) {
        const dueDay = t.due_date ? new Date(t.due_date).toISOString().split("T")[0] : null;
        if (dueDay && dueDay < today) stats.overdue++;
        if (dueDay === today) stats.due_today++;
        if (t.priority === "urgent") stats.urgent++;
      }
      const urgentTasks = openTasks.filter(t =>
        t.priority === "urgent" || t.priority === "high"
        || (t.days_until_due != null && t.days_until_due <= 3)
      ).slice(0, 6);

      res.json({
        ok: true,
        is_admin: admin,
        stats: {
          ...stats,
          hearings_this_week: hearings.length,
          deadlines_soon: deadlines.length,
          unnotified_hearings: unnotifiedCount,
        },
        urgent_tasks: urgentTasks,
        upcoming_hearings: hearings.slice(0, 15),
        upcoming_deadlines: deadlines.slice(0, 15),
      });
    } catch (err) {
      console.error("[api dashboard]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Tasks list — filtered to what the user can see
  app.get("/api/staff/tasks", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const filter = req.query.filter;
      const args = { limit: isAdmin(req.user) ? 200 : 1000 };
      if (filter === "overdue") args.overdue_only = true;
      else if (filter === "today") args.due_within_days = 0;
      else if (filter === "week") args.due_within_days = 7;
      else if (filter === "completed") args.completed_only = true;
      // Admin can filter by assignee explicitly; non-admin's own view is enforced below
      if (req.query.assigned_to && isAdmin(req.user)) args.assigned_to = req.query.assigned_to;
      if (req.query.client_key) args.client_key = req.query.client_key;
      const all = await tasks.listTasks(args);
      const items = isAdmin(req.user) ? all : all.filter(t => canUserSeeTask(req.user, t));
      res.json({ ok: true, count: items.length, tasks: items.slice(0, 200) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Task detail — 403 if user can't see it
  app.get("/api/staff/tasks/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const milestones = require("./task-milestones");
      const task = await tasks.getTask(id);
      if (!task) return res.status(404).json({ ok: false, error: "Task not found" });
      if (!canUserSeeTask(req.user, task)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      const [mList, mProgress, activity] = await Promise.all([
        milestones.listMilestones(id),
        milestones.getProgress(id),
        tasks.listActivity(id),
      ]);
      res.json({ ok: true, task, milestones: mList, progress: mProgress, activity });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Create task — defaults assignee to creator if not specified, so non-admin
  // creators can immediately see the task they just made.
  app.post("/api/staff/tasks", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const body = { ...req.body };
      const hasExplicitAssignee = body.assigned_to && String(body.assigned_to).trim();

      if (!hasExplicitAssignee) {
        if (isAdmin(req.user)) {
          // Admin without an explicit pick → try matter default, else leave blank
          const auto = await getDefaultAssignee(body.matter_type);
          if (auto) body.assigned_to = auto;
        } else {
          // Non-admin creator: self-assign so they retain visibility
          body.assigned_to = req.user.n || req.user.u;
        }
      }

      const task = await tasks.createTask({
        ...body,
        created_by: req.user.uid,
        actor_name: req.user.n || req.user.u,
        actor_role: req.user.r,
      });
      // Push to the assignee if it's not the same person creating
      if (task.assigned_to && task.assigned_to !== (req.user.n || req.user.u)) {
        push.sendToFirmByName(task.assigned_to, {
          title: `New task: ${task.title}`,
          body: `Assigned by ${req.user.n || req.user.u}${task.client_name ? ` · ${task.client_name}` : ""}`,
          data: { screen: "task", taskId: task.id },
        }).catch(() => {});
      }
      res.json({ ok: true, task });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Update task — 403 unless user can see it
  app.patch("/api/staff/tasks/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const existing = await tasks.getTask(id);
      if (!existing) return res.status(404).json({ ok: false, error: "Task not found" });
      if (!canUserSeeTask(req.user, existing)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      // Non-admin can't reassign a task to a different person (would remove it from their view unexpectedly)
      const body = { ...req.body };
      if (!isAdmin(req.user) && body.assigned_to !== undefined && body.assigned_to !== existing.assigned_to) {
        return res.status(403).json({ ok: false, error: "Only admin can reassign tasks" });
      }
      const updated = await tasks.updateTask(id, {
        ...body,
        _actor_id: req.user.uid, _actor_name: req.user.n || req.user.u, _actor_role: req.user.r,
      });
      res.json({ ok: true, task: updated });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Complete task — 403 unless user can see it
  app.post("/api/staff/tasks/:id/complete", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const existing = await tasks.getTask(id);
      if (!existing) return res.status(404).json({ ok: false, error: "Task not found" });
      if (!canUserSeeTask(req.user, existing)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      const t = await tasks.completeTask(id, {
        userId: req.user.uid,
        notes: req.body?.completion_notes || req.body?.notes,
        actorName: req.user.n || req.user.u,
        actorRole: req.user.r,
      });
      res.json({ ok: true, task: t });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Delete task — admin only, OR creator of the task
  app.delete("/api/staff/tasks/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const existing = await tasks.getTask(id);
      if (!existing) return res.status(404).json({ ok: false, error: "Task not found" });
      const isOwnCreation = existing.created_by && String(existing.created_by) === String(req.user.uid);
      if (!isAdmin(req.user) && !isOwnCreation) {
        return res.status(403).json({ ok: false, error: "Only the task creator or an admin can delete this" });
      }
      await tasks.deleteTask(id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Milestone update — check parent task ownership
  app.post("/api/staff/milestones/:id/update", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const milestones = require("./task-milestones");
      const tasks = require("./tasks");
      const before = await milestones.getMilestone(id);
      if (!before) return res.status(404).json({ ok: false, error: "Not found" });
      const parent = await tasks.getTask(before.task_id);
      if (!parent) return res.status(404).json({ ok: false, error: "Parent task not found" });
      if (!canUserSeeTask(req.user, parent)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      const updated = await milestones.updateMilestone(id, {
        ...req.body,
        completed_by: req.body?.status === "completed" ? req.user.uid : undefined,
      });
      if (updated && req.body?.status && req.body.status !== before.status) {
        await tasks.logActivity(before.task_id, {
          actor_id: req.user.uid, actor_name: req.user.n || req.user.u, actor_role: req.user.r,
          action: "status_changed",
          old_value: `milestone "${before.title}" was ${before.status}`,
          new_value: `now ${updated.status}`,
        });
      }
      res.json({ ok: true, milestone: updated });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Add milestone — check parent task ownership
  app.post("/api/staff/tasks/:id/milestones", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const parent = await tasks.getTask(id);
      if (!parent) return res.status(404).json({ ok: false, error: "Task not found" });
      if (!canUserSeeTask(req.user, parent)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      const milestones = require("./task-milestones");
      const m = await milestones.createMilestone(id, {
        title: String(req.body?.title || "").trim(),
        description: req.body?.description || null,
        due_date: req.body?.due_date || null,
      });
      res.json({ ok: true, milestone: m });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Calendar — filtered by user's clients
  app.get("/api/staff/calendar", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days || "30", 10), 90);
      const today = new Date().toISOString().split("T")[0];
      const end = new Date(Date.now() + days * 86400e3).toISOString().split("T")[0];
      const visibleKeys = await getVisibleClientKeys(req.user);
      const [allH, allD] = await Promise.all([
        db.query(
          `SELECT id, client_key, client_name, a_number, hearing_date, hearing_type, court_name, judge_name
           FROM client_hearing_notices WHERE hearing_date >= $1 AND hearing_date <= $2 AND dismissed_at IS NULL
           ORDER BY hearing_date ASC`, [today, end]
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT id, description, due_date, priority, client_key, client_name, source_type
           FROM deadlines WHERE status = 'pending' AND due_date <= $1
           ORDER BY due_date ASC`, [end]
        ).then(r => r.rows).catch(() => []),
      ]);
      const hearings = filterByClientKeys(allH, visibleKeys);
      const deadlines = filterByClientKeys(allD, visibleKeys);
      res.json({ ok: true, hearings, deadlines, window_days: days, is_admin: isAdmin(req.user) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Clients — search + list, filtered to user's clients
  app.get("/api/staff/clients", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const mobile = require("./mobile-app");
      const q = req.query.q || "";
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const visibleKeys = await getVisibleClientKeys(req.user);

      let results;
      if (q && q.length >= 2) {
        results = await mobile.searchClients(q, 500);
      } else {
        const cp = require("./client-profiles");
        const all = await cp.aggregateClients();
        results = all.map(c => ({
          key: c.key, client_name: c.client_name, a_number: c.a_number,
          client_phone: c.client_phone, client_email: c.client_email,
          case_types: Array.from(c.case_types || []),
          total_hearings: (c.hearings || []).length,
        }));
      }

      // Merge in any linked client_accounts that aren't already in the roster.
      // Ensures phones the admin has manually linked show up in the Clients tab
      // even when the client has no hearings/tasks/deadlines yet.
      try {
        const existingKeys = new Set(results.map(r => r.key).filter(Boolean));
        const acctQ = q && q.length >= 2
          ? `SELECT DISTINCT client_key, full_name, email, phone
             FROM client_accounts
             WHERE client_key IS NOT NULL AND client_key != ''
               AND (LOWER(full_name) LIKE $1 OR client_key LIKE $1 OR phone LIKE $1)`
          : `SELECT DISTINCT client_key, full_name, email, phone
             FROM client_accounts
             WHERE client_key IS NOT NULL AND client_key != ''`;
        const acctParams = q && q.length >= 2 ? [`%${q.toLowerCase()}%`] : [];
        const acctR = await db.query(acctQ, acctParams);
        for (const row of acctR.rows) {
          if (!existingKeys.has(row.client_key)) {
            results.push({
              key: row.client_key,
              client_name: row.full_name || row.client_key,
              client_phone: row.phone,
              client_email: row.email,
              case_types: [],
              total_hearings: 0,
              app_linked: true,   // signal to UI: this client has app access
            });
            existingKeys.add(row.client_key);
          } else {
            // Existing roster entry — annotate as app-linked
            const idx = results.findIndex(r => r.key === row.client_key);
            if (idx >= 0) results[idx].app_linked = true;
          }
        }
      } catch (e) {
        console.warn("[clients merge accounts]:", e.message);
      }

      // Filter to visible clients
      const filtered = filterByClientKeys(results, visibleKeys, "key");
      res.json({
        ok: true,
        count: filtered.length,
        clients: filtered.slice(0, limit),
        is_admin: isAdmin(req.user),
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Client detail — 403 unless user has access
  app.get("/api/staff/clients/:key", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "You don't have access to this client" });
      const mobile = require("./mobile-app");
      const client = await mobile.getClientDetail(req.params.key);
      if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
      res.json({ ok: true, client });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Master hearing notes list — filtered by user's clients OR notes they authored
  app.get("/api/staff/notes/master", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const admin = isAdmin(req.user);
      const q = admin
        ? `SELECT id, client_key, client_name, a_number, hearing_date, judge_name, court_location,
                  client_language, paralegal_summary, created_at, created_by
           FROM hearing_notes ORDER BY hearing_date DESC NULLS LAST, created_at DESC LIMIT $1`
        : `SELECT id, client_key, client_name, a_number, hearing_date, judge_name, court_location,
                  client_language, paralegal_summary, created_at, created_by
           FROM hearing_notes ORDER BY hearing_date DESC NULLS LAST, created_at DESC LIMIT $1`;
      const r = await db.query(q, [admin ? limit : 500]);
      let notes = r.rows;
      if (!admin) {
        const visibleKeys = await getVisibleClientKeys(req.user);
        // Include note if EITHER its client_key is visible OR the user created it
        notes = notes.filter(n =>
          (n.client_key && visibleKeys.has(n.client_key))
          || (n.created_by && String(n.created_by) === String(req.user.uid))
        );
        notes = notes.slice(0, limit);
      }
      res.json({ ok: true, count: notes.length, notes });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Master note detail — 403 unless user can access
  app.get("/api/staff/notes/master/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const r = await db.query(`SELECT * FROM hearing_notes WHERE id = $1`, [id]);
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });
      const note = r.rows[0];
      if (!isAdmin(req.user)) {
        const okKey = note.client_key ? await canUserAccessClient(req.user, note.client_key) : false;
        const okAuthor = note.created_by && String(note.created_by) === String(req.user.uid);
        if (!okKey && !okAuthor) return res.status(403).json({ ok: false, error: "You don't have access to this note" });
      }
      res.json({ ok: true, note });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Individual notes list — same filter as master notes
  app.get("/api/staff/notes/individual", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const admin = isAdmin(req.user);
      const r = await db.query(
        `SELECT id, client_key, client_name, a_number, hearing_date, judge_name, court_location,
                client_language, case_type, disposition, paralegal_summary, created_at, created_by
         FROM individual_hearing_notes ORDER BY hearing_date DESC NULLS LAST, created_at DESC LIMIT $1`,
        [admin ? limit : 500]
      ).catch(() => ({ rows: [] }));
      let notes = r.rows;
      if (!admin) {
        const visibleKeys = await getVisibleClientKeys(req.user);
        notes = notes.filter(n =>
          (n.client_key && visibleKeys.has(n.client_key))
          || (n.created_by && String(n.created_by) === String(req.user.uid))
        ).slice(0, limit);
      }
      res.json({ ok: true, count: notes.length, notes });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Federal / Trademark matters — admin sees all; others see matters with matching
  // assigned attorney or client_key visible to them.
  app.get("/api/staff/federal", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT * FROM federal_matters ORDER BY next_deadline ASC NULLS LAST, created_at DESC LIMIT 500`
      ).catch(() => ({ rows: [] }));
      let matters = r.rows;
      if (!isAdmin(req.user)) {
        const visibleKeys = await getVisibleClientKeys(req.user);
        const terms = userAssignmentTerms(req.user);
        matters = matters.filter(m => {
          // Match by client_key
          if (m.client_key && visibleKeys.has(m.client_key)) return true;
          // Match by assigned attorney field (if the table has one)
          const assigned = String(m.assigned_to || m.attorney || "").toLowerCase();
          if (assigned && terms.some(t => assigned.includes(t))) return true;
          return false;
        }).slice(0, 200);
      }
      res.json({ ok: true, count: matters.length, matters });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // PI cases — same visibility model as federal
  app.get("/api/staff/pi", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT * FROM pi_cases ORDER BY updated_at DESC NULLS LAST LIMIT 500`
      ).catch(() => ({ rows: [] }));
      let cases = r.rows;
      if (!isAdmin(req.user)) {
        const visibleKeys = await getVisibleClientKeys(req.user);
        const terms = userAssignmentTerms(req.user);
        cases = cases.filter(c => {
          if (c.client_key && visibleKeys.has(c.client_key)) return true;
          const assigned = String(c.assigned_to || c.attorney || "").toLowerCase();
          if (assigned && terms.some(t => assigned.includes(t))) return true;
          return false;
        }).slice(0, 200);
      }
      res.json({ ok: true, count: cases.length, cases });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Zara chat — available to all firm users (personal AI assistant, no shared data)
  app.post("/api/staff/chat", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message) return res.status(400).json({ ok: false, error: "message required" });
      let zaraChat;
      try { zaraChat = require("./zara-app-chat"); } catch { zaraChat = null; }
      if (!zaraChat || typeof zaraChat.chat !== "function") {
        return res.status(501).json({ ok: false, error: "Chat not available on backend" });
      }
      const answer = await zaraChat.chat({
        systemPrompt: zaraChat.STAFF_SYSTEM_PROMPT,
        message: String(message),
        history: history || [],
        db,
        user: req.user,
      });
      res.json({ ok: true, reply: { answer } });
    } catch (err) {
      console.error("[api chat staff]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  PUSH TOKEN REGISTRATION
  //  ─────────────────────────────────────────────────────
  //  Called by the app on first launch after login (any role) to record
  //  their Expo push token. Called again on token refresh.
  // ═══════════════════════════════════════════════════════

  app.post("/api/push/register", requireBearer, async (req, res) => {
    try {
      const token = String(req.body?.expo_token || "").trim();
      const platform = String(req.body?.platform || "").trim();
      if (!token || !token.startsWith("ExponentPushToken")) {
        return res.status(400).json({ ok: false, error: "Invalid expo_token" });
      }
      const user = req.user;
      // Determine user kind + ref from JWT
      let userKind = "firm", userRef = String(user.uid || "");
      if (user.k === "consultant") userKind = "consultant";
      else if (user.k === "client") { userKind = "client"; userRef = user.phone || String(user.uid || ""); }

      await db.query(`
        INSERT INTO push_tokens (user_kind, user_ref, expo_token, platform, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (expo_token) DO UPDATE
          SET user_kind = EXCLUDED.user_kind,
              user_ref = EXCLUDED.user_ref,
              platform = EXCLUDED.platform,
              updated_at = NOW()
      `, [userKind, userRef, token, platform || null]);

      res.json({ ok: true });
    } catch (err) {
      console.error("[push register]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/push/unregister", requireBearer, async (req, res) => {
    try {
      const token = String(req.body?.expo_token || "").trim();
      if (token) await db.query(`DELETE FROM push_tokens WHERE expo_token = $1`, [token]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // USCIS receipt lookup — available to all firm users (public government data)
  app.get("/api/staff/uscis/:receipt", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const uscis = require("./uscis");
      const status = await uscis.lookupReceipt(req.params.receipt);
      res.json({ ok: true, status });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  ADMIN: CLIENT ACCOUNT LINKING (admin role only)
  //  ─────────────────────────────────────────────────────
  //  When a client signs in via SMS OTP for the first time, the backend
  //  tries to auto-link their phone to an existing case (via matching
  //  phone_number in client_hearing_notices). If no match, the account is
  //  created but unlinked — the client sees "account being set up" until
  //  admin links them here.
  // ═══════════════════════════════════════════════════════

  function requireAdmin(req, res, next) {
    if (!req.user || req.user.r !== "admin") {
      return res.status(403).json({ ok: false, error: "Admin only" });
    }
    next();
  }

  function requireManagerOrAdmin(req, res, next) {
    if (!req.user || (req.user.r !== "admin" && req.user.r !== "manager")) {
      return res.status(403).json({ ok: false, error: "Manager or admin only" });
    }
    next();
  }

  // ═══════════════════════════════════════════════════════
  //  TEAM MANAGEMENT (admin only — list users, change roles)
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/admin/users", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, username, full_name, role, email, disabled, created_at
         FROM admin_users
         ORDER BY (role = 'admin') DESC, (role = 'manager') DESC, full_name ASC`
      );
      res.json({ ok: true, users: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/admin/users/:id/role", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const role = String(req.body?.role || "").trim();
      const validRoles = ["admin", "manager", "attorney", "paralegal", "viewer", "consultant"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ ok: false, error: `role must be one of ${validRoles.join(", ")}` });
      }
      // Safety: don't let JJ demote himself accidentally
      if (id === req.user.uid && role !== "admin") {
        return res.status(400).json({ ok: false, error: "Cannot change your own role from admin. Have another admin do it." });
      }
      const r = await db.query(
        `UPDATE admin_users SET role = $1 WHERE id = $2 RETURNING id, username, full_name, role`,
        [role, id]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "user not found" });
      res.json({ ok: true, user: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/admin/users/:id/disabled", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      if (id === req.user.uid) {
        return res.status(400).json({ ok: false, error: "Cannot disable yourself" });
      }
      const disabled = !!req.body?.disabled;
      const r = await db.query(
        `UPDATE admin_users SET disabled = $1 WHERE id = $2 RETURNING id, username, full_name, role, disabled`,
        [disabled, id]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "user not found" });
      // If disabling a consultant, sever all their client assignments
      if (disabled && r.rows[0].role === "consultant" && typeof app.locals.cleanupConsultantAssignments === "function") {
        try {
          await app.locals.cleanupConsultantAssignments(id, req.user.uid, "User disabled by admin");
        } catch (e) { console.warn("[cleanup consultant]:", e.message); }
      }
      res.json({ ok: true, user: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  TASK REASSIGNMENT (admin + manager)
  // ═══════════════════════════════════════════════════════

  app.patch("/api/staff/tasks/:id/reassign", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const assigned_to = String(req.body?.assigned_to || "").trim();
      if (!assigned_to) return res.status(400).json({ ok: false, error: "assigned_to required" });
      const r = await db.query(
        `UPDATE tasks SET assigned_to = $1, updated_at = NOW() WHERE id = $2 RETURNING id, description, assigned_to`,
        [assigned_to, id]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "task not found" });
      res.json({ ok: true, task: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // List all client accounts (paginated by created date)
  app.get("/api/staff/admin/client-accounts", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);
      const filter = req.query.filter;  // 'linked' | 'unlinked' | undefined
      let whereClause = "";
      if (filter === "linked") whereClause = "WHERE client_key IS NOT NULL AND client_key != ''";
      else if (filter === "unlinked") whereClause = "WHERE client_key IS NULL OR client_key = ''";
      const r = await db.query(
        `SELECT id, phone, client_key, full_name, email, preferred_lang, last_login_at, created_at
         FROM client_accounts ${whereClause}
         ORDER BY (client_key IS NULL OR client_key = '') DESC, last_login_at DESC NULLS LAST, created_at DESC
         LIMIT $1`,
        [limit]
      );
      // Also compute quick stats
      const statsR = await db.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE client_key IS NOT NULL AND client_key != '')::int AS linked,
           COUNT(*) FILTER (WHERE client_key IS NULL OR client_key = '')::int AS unlinked
         FROM client_accounts`
      );
      res.json({
        ok: true,
        accounts: r.rows,
        stats: statsR.rows[0] || { total: 0, linked: 0, unlinked: 0 },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Search for a client to link to. Returns candidates from the aggregated
  // client roster (client_profiles / hearing_notices union).
  app.get("/api/staff/admin/client-search", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);
      if (q.length < 2) return res.json({ ok: true, clients: [] });
      const mobile = require("./mobile-app");
      const results = await mobile.searchClients(q, limit);
      res.json({ ok: true, clients: results });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Link a client account to a case (by client_key + client_name)
  app.post("/api/staff/admin/client-accounts/:id/link", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const clientKey = String(req.body?.client_key || "").trim();
      const clientName = String(req.body?.client_name || "").trim();
      if (!clientKey) return res.status(400).json({ ok: false, error: "client_key required" });
      const r = await db.query(
        `UPDATE client_accounts SET client_key = $2, full_name = COALESCE(NULLIF($3, ''), full_name) WHERE id = $1 RETURNING *`,
        [id, clientKey, clientName]
      );
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Account not found" });
      res.json({ ok: true, account: r.rows[0] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Unlink an account (client_key -> null)
  app.post("/api/staff/admin/client-accounts/:id/unlink", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const r = await db.query(
        `UPDATE client_accounts SET client_key = NULL WHERE id = $1 RETURNING *`,
        [id]
      );
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Account not found" });
      res.json({ ok: true, account: r.rows[0] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Update account details (name, email, lang)
  app.patch("/api/staff/admin/client-accounts/:id", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const { full_name, email, preferred_lang } = req.body || {};
      const fields = [];
      const vals = [id];
      let idx = 2;
      if (full_name !== undefined) { fields.push(`full_name = $${idx++}`); vals.push(full_name); }
      if (email !== undefined) { fields.push(`email = $${idx++}`); vals.push(email); }
      if (preferred_lang !== undefined) { fields.push(`preferred_lang = $${idx++}`); vals.push(preferred_lang); }
      if (!fields.length) return res.status(400).json({ ok: false, error: "No fields to update" });
      const r = await db.query(
        `UPDATE client_accounts SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
        vals
      );
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Account not found" });
      res.json({ ok: true, account: r.rows[0] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Preemptively create a client account (link a phone to a case BEFORE
  // the client signs in). Client can then sign in via SMS and immediately
  // see their case.
  app.post("/api/staff/admin/client-accounts", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!phone) return res.status(400).json({ ok: false, error: "Valid phone required" });
      const clientKey = req.body?.client_key ? String(req.body.client_key).trim() : null;
      const fullName = req.body?.full_name ? String(req.body.full_name).trim() : null;
      const preferredLang = ["en", "zh-TW", "es"].includes(req.body?.preferred_lang)
        ? req.body.preferred_lang : "en";
      // Upsert on phone
      const r = await db.query(
        `INSERT INTO client_accounts (phone, client_key, full_name, preferred_lang)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone) DO UPDATE
           SET client_key = COALESCE(EXCLUDED.client_key, client_accounts.client_key),
               full_name = COALESCE(EXCLUDED.full_name, client_accounts.full_name),
               preferred_lang = EXCLUDED.preferred_lang
         RETURNING *`,
        [phone, clientKey, fullName, preferredLang]
      );
      res.json({ ok: true, account: r.rows[0] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Delete an account entirely (rare — mostly for cleanup)
  app.delete("/api/staff/admin/client-accounts/:id", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      await db.query(`DELETE FROM client_accounts WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  ADMIN: MATTER-TYPE DEFAULT ASSIGNMENTS
  //  ─────────────────────────────────────────────────────
  //  Controls auto-assignment when a task is created without an assignee.
  //  Applied to admin-created tasks and consultant work orders.
  //  Non-admin firm users still self-assign (to keep visibility).
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/admin/matter-defaults", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT matter_type, assigned_to, updated_at
         FROM matter_defaults
         ORDER BY matter_type`
      );
      res.json({ ok: true, defaults: r.rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch("/api/staff/admin/matter-defaults/:matter_type", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const matterType = String(req.params.matter_type || "").trim();
      const assignee = String(req.body?.assigned_to || "").trim();
      if (!matterType) return res.status(400).json({ ok: false, error: "matter_type required" });
      if (!assignee) return res.status(400).json({ ok: false, error: "assigned_to required" });
      const r = await db.query(
        `INSERT INTO matter_defaults (matter_type, assigned_to, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (matter_type) DO UPDATE
           SET assigned_to = EXCLUDED.assigned_to, updated_at = NOW()
         RETURNING *`,
        [matterType, assignee]
      );
      invalidateMatterDefaultsCache();  // force reload on next task creation
      res.json({ ok: true, default: r.rows[0] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  ADMIN: CONSULTANT WORK ORDER APPROVAL
  //  ─────────────────────────────────────────────────────
  //  Consultants submit tasks with status='pending_approval'. Those tasks
  //  are hidden from the auto-assigned firm member until JJ approves.
  //  Admin can approve as-is, modify fields before approving, or reject
  //  with a reason.
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/admin/tasks/pending", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT t.*,
                au.full_name AS submitter_name,
                au.username  AS submitter_username
         FROM tasks t
         LEFT JOIN admin_users au ON au.id = t.submitted_by_user_id
         WHERE t.status = 'pending_approval'
         ORDER BY t.created_at DESC
         LIMIT 200`
      );
      // Enrich with default assignee info so admin sees "will go to X"
      const rows = r.rows.map(row => ({
        ...row,
        proposed_assignee: row.assigned_to,
      }));
      res.json({ ok: true, tasks: rows, count: rows.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Approve a pending task. Body may include field overrides (assigned_to,
  // priority, due_date, matter_type). Task becomes status='open' and enters
  // the assignee's queue.
  app.post("/api/staff/admin/tasks/:id/approve", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });

      // Load existing to ensure it's actually pending
      const existing = await db.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
      if (!existing.rows.length) return res.status(404).json({ ok: false, error: "Task not found" });
      const t = existing.rows[0];
      if (t.status !== "pending_approval") {
        return res.status(400).json({ ok: false, error: `Task is not pending (current: ${t.status})` });
      }

      // Apply any admin overrides
      const overrides = req.body || {};
      const fields = ["status = 'open'"];
      const vals = [id];
      let idx = 2;
      if (overrides.assigned_to !== undefined) { fields.push(`assigned_to = $${idx++}`); vals.push(overrides.assigned_to); }
      if (overrides.priority && ["urgent","high","normal","low"].includes(overrides.priority)) {
        fields.push(`priority = $${idx++}`); vals.push(overrides.priority);
      }
      if (overrides.due_date && /^\d{4}-\d{2}-\d{2}$/.test(overrides.due_date)) {
        fields.push(`due_date = $${idx++}`); vals.push(overrides.due_date);
      }
      if (overrides.matter_type) { fields.push(`matter_type = $${idx++}`); vals.push(overrides.matter_type); }

      const r = await db.query(
        `UPDATE tasks SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
        vals
      );
      const approvedTask = r.rows[0];
      // Notify the assignee that they have a new task
      if (approvedTask.assigned_to) {
        push.sendToFirmByName(approvedTask.assigned_to, {
          title: `Approved: ${approvedTask.title}`,
          body: `New task in your queue${approvedTask.client_name ? ` · ${approvedTask.client_name}` : ""}`,
          data: { screen: "task", taskId: approvedTask.id },
        }).catch(() => {});
      }
      // Notify the consultant that their submission was approved
      if (approvedTask.submitted_by_user_id) {
        push.sendToUser("consultant", approvedTask.submitted_by_user_id, {
          title: "✓ Work order approved",
          body: `Your submission "${approvedTask.title}" has been approved.`,
          data: { screen: "consultant-task", taskId: approvedTask.id },
        }).catch(() => {});
      }
      // Log activity
      try {
        const tasks = require("./tasks");
        if (typeof tasks.recordActivity === "function") {
          await tasks.recordActivity(id, {
            kind: "approved",
            actor_id: req.user.uid,
            actor_name: req.user.n || req.user.u,
            actor_role: req.user.r,
            note: overrides.note || "Approved",
            visible_to_submitter: true,
          });
        }
      } catch (e) { /* activity log optional */ }
      res.json({ ok: true, task: approvedTask });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reject a pending task with a reason. Consultant sees the reason.
  app.post("/api/staff/admin/tasks/:id/reject", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ ok: false, error: "Rejection reason required" });

      const existing = await db.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
      if (!existing.rows.length) return res.status(404).json({ ok: false, error: "Task not found" });
      const t = existing.rows[0];
      if (t.status !== "pending_approval") {
        return res.status(400).json({ ok: false, error: `Task is not pending (current: ${t.status})` });
      }

      const r = await db.query(
        `UPDATE tasks SET status = 'rejected' WHERE id = $1 RETURNING *`,
        [id]
      );
      // Log rejection reason as activity
      try {
        const tasks = require("./tasks");
        if (typeof tasks.recordActivity === "function") {
          await tasks.recordActivity(id, {
            kind: "rejected",
            actor_id: req.user.uid,
            actor_name: req.user.n || req.user.u,
            actor_role: req.user.r,
            note: reason,
            visible_to_submitter: true,
          });
        }
      } catch (e) { /* activity log optional */ }
      res.json({ ok: true, task: r.rows[0] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Pending count — for badges on home dashboard
  app.get("/api/staff/admin/tasks/pending-count", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const r = await db.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'pending_approval'`);
      res.json({ ok: true, count: r.rows[0]?.n || 0 });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Firm-side: view messages with a client — 403 unless user can access
  app.get("/api/staff/clients/:key/messages", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "You don't have access to this client" });
      const r = await db.query(
        `SELECT * FROM client_messages WHERE client_key = $1 ORDER BY created_at ASC LIMIT 200`,
        [req.params.key]
      );
      res.json({ ok: true, messages: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Firm-side: send message to client — 403 unless user can access
  app.post("/api/staff/clients/:key/messages", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const clientKey = req.params.key;
      const ok = await canUserAccessClient(req.user, clientKey);
      if (!ok) return res.status(403).json({ ok: false, error: "You don't have access to this client" });
      const body = String(req.body?.body || "").trim().substring(0, 4000);
      if (!body) return res.status(400).json({ ok: false, error: "Message body required" });
      const r = await db.query(
        `INSERT INTO client_messages (client_key, sender_kind, sender_name, sender_id, body)
         VALUES ($1, 'firm', $2, $3, $4) RETURNING *`,
        [clientKey, req.user.n || req.user.u, req.user.uid, body]
      );
      // Push notify the client — look up their phone from client_accounts
      try {
        const phoneR = await db.query(
          `SELECT phone FROM client_accounts WHERE client_key = $1 LIMIT 1`,
          [clientKey]
        );
        const phone = phoneR.rows[0]?.phone;
        if (phone) {
          push.sendToUser("client", phone, {
            title: `Tez Law: ${req.user.n || req.user.u}`,
            body: body.substring(0, 100),
            data: { screen: "client-messages" },
          }).catch(() => {});
        }
      } catch {}
      res.json({ ok: true, message: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  QUICK-REPLY TEMPLATES (firm messaging productivity)
  //  ─────────────────────────────────────────────────────
  //  All firm staff can list & use templates.
  //  Only admins can create, edit, or delete.
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/templates", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const category = req.query.category;
      const params = [];
      let sql = `SELECT id, name, body, category, created_at FROM quick_reply_templates`;
      if (category) {
        sql += ` WHERE category = $1`;
        params.push(String(category));
      }
      sql += ` ORDER BY category, name`;
      const r = await db.query(sql, params);
      res.json({ ok: true, templates: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/staff/admin/templates", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      const body = String(req.body?.body || "").trim();
      const category = String(req.body?.category || "general").trim();
      if (!name || !body) return res.status(400).json({ ok: false, error: "name and body required" });
      const r = await db.query(
        `INSERT INTO quick_reply_templates (name, body, category, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, body, category, req.user.uid]
      );
      res.json({ ok: true, template: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/admin/templates/:id", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const fields = [];
      const params = [];
      let i = 1;
      for (const key of ['name', 'body', 'category']) {
        if (typeof req.body?.[key] === 'string') {
          fields.push(`${key} = $${i++}`);
          params.push(req.body[key]);
        }
      }
      if (!fields.length) return res.status(400).json({ ok: false, error: "nothing to update" });
      fields.push(`updated_at = NOW()`);
      params.push(id);
      const r = await db.query(
        `UPDATE quick_reply_templates SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, template: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.delete("/api/staff/admin/templates/:id", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      await db.query(`DELETE FROM quick_reply_templates WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CLIENT DOCUMENTS
  //  ─────────────────────────────────────────────────────
  //  Client can upload photos/PDFs of ID, contracts, notices, etc.
  //  Firm can list & download for a given client key.
  //  Storage: PostgreSQL BYTEA (OK for MVP; migrate to S3/B2 later if volume grows).
  //  Max size enforced at 8 MB per file to keep DB size manageable.
  // ═══════════════════════════════════════════════════════

  const MAX_DOC_BYTES = 8 * 1024 * 1024;

  // CLIENT: upload a document to their own case
  app.post("/api/client/documents", requireBearer, requireClient, async (req, res) => {
    try {
      const { filename, mime_type, category, note, content_base64 } = req.body || {};
      if (!filename || !content_base64) {
        return res.status(400).json({ ok: false, error: "filename and content_base64 required" });
      }
      // Look up client_key from their account
      const acctR = await db.query(
        `SELECT client_key FROM client_accounts WHERE id = $1 LIMIT 1`,
        [req.user.uid]
      );
      const clientKey = acctR.rows[0]?.client_key;
      if (!clientKey) {
        return res.status(400).json({ ok: false, error: "Your account isn't linked to a case yet. Please contact your legal team." });
      }
      // Decode + validate size
      const buf = Buffer.from(String(content_base64), 'base64');
      if (buf.length === 0) return res.status(400).json({ ok: false, error: "empty file" });
      if (buf.length > MAX_DOC_BYTES) {
        return res.status(413).json({ ok: false, error: `File too large. Max ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB.` });
      }
      const r = await db.query(
        `INSERT INTO client_documents
           (client_key, client_id, filename, mime_type, size_bytes, category, note, content, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'client')
         RETURNING id, filename, mime_type, size_bytes, category, note, uploaded_at`,
        [clientKey, req.user.uid, String(filename).substring(0, 200),
         String(mime_type || 'application/octet-stream').substring(0, 100),
         buf.length, String(category || 'other').substring(0, 50),
         note ? String(note).substring(0, 500) : null,
         buf]
      );
      // Notify firm admins that a new client document arrived
      try {
        const push = require("./push-notifications");
        await push.sendToAdmins({
          title: `📄 New document from client`,
          body: `${filename} · ${Math.round(buf.length / 1024)} KB`,
          data: { type: 'client_document', client_key: clientKey },
        });
      } catch {}
      res.json({ ok: true, document: r.rows[0] });
    } catch (err) {
      console.error("[client doc upload]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // CLIENT: list their own uploaded documents
  app.get("/api/client/documents", requireBearer, requireClient, async (req, res) => {
    try {
      const acctR = await db.query(
        `SELECT client_key FROM client_accounts WHERE id = $1 LIMIT 1`,
        [req.user.uid]
      );
      const clientKey = acctR.rows[0]?.client_key;
      if (!clientKey) return res.json({ ok: true, documents: [] });
      const r = await db.query(
        `SELECT id, filename, mime_type, size_bytes, category, note, uploaded_by, uploaded_at
         FROM client_documents WHERE client_key = $1 ORDER BY uploaded_at DESC`,
        [clientKey]
      );
      res.json({ ok: true, documents: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // FIRM: list documents for a specific client
  app.get("/api/staff/clients/:key/documents", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "You don't have access to this client" });
      const r = await db.query(
        `SELECT id, filename, mime_type, size_bytes, category, note, uploaded_by, uploaded_at
         FROM client_documents WHERE client_key = $1 ORDER BY uploaded_at DESC`,
        [req.params.key]
      );
      res.json({ ok: true, documents: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Download a specific document (both client + firm — auth handled by joining on client_key)
  app.get("/api/documents/:id", requireBearer, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `SELECT filename, mime_type, content, client_key FROM client_documents WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      const doc = r.rows[0];
      // Auth: client can only download docs from their own case; firm can if they have client access
      if (req.user.k === 'client') {
        const acctR = await db.query(
          `SELECT client_key FROM client_accounts WHERE id = $1 LIMIT 1`,
          [req.user.uid]
        );
        if (acctR.rows[0]?.client_key !== doc.client_key) {
          return res.status(403).json({ ok: false, error: "not your document" });
        }
      } else {
        const ok = await canUserAccessClient(req.user, doc.client_key);
        if (!ok) return res.status(403).json({ ok: false, error: "no access to this client" });
      }
      res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
      res.send(doc.content);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CLIENT INVOICES
  //  ─────────────────────────────────────────────────────
  //  Admin creates an invoice for a client (amount + description +
  //  optional credit-card link). Client sees it with payment options
  //  (Zelle, check, credit card link if provided) and can flag it as
  //  paid. Admin manually confirms payment received.
  // ═══════════════════════════════════════════════════════

  // ADMIN: create an invoice
  app.post("/api/staff/admin/invoices", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const { client_key, description, amount_cents, due_date, notes, credit_card_link, time_entry_ids } = req.body || {};
      if (!client_key || !description || !amount_cents) {
        return res.status(400).json({ ok: false, error: "client_key, description, amount_cents required" });
      }
      const amt = parseInt(amount_cents, 10);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ ok: false, error: "amount_cents must be a positive integer" });
      }
      const r = await db.query(
        `INSERT INTO client_invoices
           (client_key, description, amount_cents, due_date, notes, credit_card_link, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7)
         RETURNING *`,
        [String(client_key), String(description).substring(0, 500), amt,
         due_date || null,
         notes ? String(notes).substring(0, 1000) : null,
         credit_card_link ? String(credit_card_link).substring(0, 500) : null,
         req.user.uid]
      );
      // Link any provided time entries to this invoice (marks them as billed)
      const invoiceId = r.rows[0].id;
      if (Array.isArray(time_entry_ids) && time_entry_ids.length) {
        const ids = time_entry_ids.map(x => parseInt(x, 10)).filter(Number.isFinite);
        if (ids.length) {
          await db.query(
            `UPDATE time_entries SET invoice_id = $1, updated_at = NOW()
             WHERE id = ANY($2::int[]) AND client_key = $3 AND invoice_id IS NULL`,
            [invoiceId, ids, String(client_key)]
          );
        }
      }
      // Push notification to the client account(s) linked to this key
      try {
        const push = require("./push-notifications");
        const acctR = await db.query(
          `SELECT id FROM client_accounts WHERE client_key = $1`,
          [String(client_key)]
        );
        for (const row of acctR.rows) {
          await push.sendToUser("client", row.id, {
            title: "💰 New invoice from Tez Law",
            body: `${description} · $${(amt / 100).toFixed(2)}`,
            data: { type: "invoice", invoice_id: r.rows[0].id },
          });
        }
      } catch (e) { console.warn("[invoice push]:", e.message); }
      res.json({ ok: true, invoice: r.rows[0] });
    } catch (err) {
      console.error("[create invoice]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // FIRM: list invoices for a client
  app.get("/api/staff/clients/:key/invoices", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access to this client" });
      const r = await db.query(
        `SELECT * FROM client_invoices WHERE client_key = $1 ORDER BY created_at DESC`,
        [req.params.key]
      );
      res.json({ ok: true, invoices: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ADMIN: mark invoice paid
  app.patch("/api/staff/admin/invoices/:id/mark-paid", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const paid_method = String(req.body?.paid_method || "other").substring(0, 40);
      const paid_note = req.body?.paid_note ? String(req.body.paid_note).substring(0, 500) : null;
      const r = await db.query(
        `UPDATE client_invoices
         SET status = 'paid', paid_at = NOW(), paid_method = $1, paid_note = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [paid_method, paid_note, id]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      // Notify client of confirmation
      try {
        const push = require("./push-notifications");
        const inv = r.rows[0];
        const acctR = await db.query(
          `SELECT id FROM client_accounts WHERE client_key = $1`,
          [inv.client_key]
        );
        for (const row of acctR.rows) {
          await push.sendToUser("client", row.id, {
            title: "✓ Payment confirmed",
            body: `${inv.description} · $${(inv.amount_cents / 100).toFixed(2)} · marked paid`,
            data: { type: "invoice_paid", invoice_id: inv.id },
          });
        }
      } catch {}
      res.json({ ok: true, invoice: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ADMIN: void invoice
  app.patch("/api/staff/admin/invoices/:id/void", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `UPDATE client_invoices
         SET status = 'void', updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, invoice: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ADMIN: delete invoice (hard delete — only for corrections)
  app.delete("/api/staff/admin/invoices/:id", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      await db.query(`DELETE FROM client_invoices WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // CLIENT: list own invoices
  app.get("/api/client/invoices", requireBearer, requireClient, async (req, res) => {
    try {
      const acctR = await db.query(
        `SELECT client_key FROM client_accounts WHERE id = $1 LIMIT 1`,
        [req.user.uid]
      );
      const clientKey = acctR.rows[0]?.client_key;
      if (!clientKey) return res.json({ ok: true, invoices: [] });
      const r = await db.query(
        `SELECT id, description, amount_cents, due_date, notes, credit_card_link,
                status, paid_at, paid_method, client_claim_paid_at, created_at
         FROM client_invoices WHERE client_key = $1 ORDER BY created_at DESC`,
        [clientKey]
      );
      res.json({ ok: true, invoices: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // CLIENT: flag as paid (informational — admin still confirms)
  app.patch("/api/client/invoices/:id/claim-paid", requireBearer, requireClient, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const note = req.body?.note ? String(req.body.note).substring(0, 500) : null;
      // Verify this invoice belongs to this client
      const acctR = await db.query(
        `SELECT client_key FROM client_accounts WHERE id = $1 LIMIT 1`,
        [req.user.uid]
      );
      const clientKey = acctR.rows[0]?.client_key;
      if (!clientKey) return res.status(403).json({ ok: false, error: "no linked case" });
      const r = await db.query(
        `UPDATE client_invoices
         SET client_claim_paid_at = NOW(), client_claim_note = $1, updated_at = NOW()
         WHERE id = $2 AND client_key = $3 RETURNING *`,
        [note, id, clientKey]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or not yours" });
      // Notify admins
      try {
        const push = require("./push-notifications");
        const inv = r.rows[0];
        await push.sendToAdmins({
          title: "💵 Client flagged invoice as paid",
          body: `$${(inv.amount_cents / 100).toFixed(2)} · ${inv.description}${note ? ` · "${note.substring(0, 50)}"` : ''}`,
          data: { type: "invoice_claim_paid", invoice_id: inv.id, client_key: inv.client_key },
        });
      } catch {}
      res.json({ ok: true, invoice: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  TIME TRACKING
  //  ─────────────────────────────────────────────────────
  //  Staff track billable + non-billable time against clients and
  //  optionally against specific tasks. Timer entries (start_at set,
  //  ended_at null) can be paused/stopped. Manual entries capture
  //  minutes worked directly.
  // ═══════════════════════════════════════════════════════

  // Get the current active (running) timer for this staff member
  app.get("/api/staff/time-entries/active", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, client_key, task_id, description, started_at, hourly_rate_cents, billable
         FROM time_entries
         WHERE staff_id = $1 AND ended_at IS NULL AND started_at IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
        [req.user.uid]
      );
      res.json({ ok: true, active: r.rows[0] || null });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Start a new timer
  app.post("/api/staff/time-entries/start", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const { client_key, task_id, description, hourly_rate_cents, billable } = req.body || {};
      if (!description) return res.status(400).json({ ok: false, error: "description required" });
      // First stop any existing active timer for this user
      await db.query(
        `UPDATE time_entries
         SET ended_at = NOW(),
             minutes = COALESCE(minutes, GREATEST(1, EXTRACT(EPOCH FROM (NOW() - started_at))/60)::int),
             updated_at = NOW()
         WHERE staff_id = $1 AND ended_at IS NULL AND started_at IS NOT NULL`,
        [req.user.uid]
      );
      const r = await db.query(
        `INSERT INTO time_entries
           (staff_id, client_key, task_id, description, hourly_rate_cents, billable, started_at, entry_date)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), CURRENT_DATE) RETURNING *`,
        [req.user.uid,
         client_key || null,
         task_id ? parseInt(task_id, 10) : null,
         String(description).substring(0, 500),
         hourly_rate_cents ? parseInt(hourly_rate_cents, 10) : null,
         billable !== false]
      );
      res.json({ ok: true, entry: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Stop the active timer
  app.post("/api/staff/time-entries/:id/stop", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `UPDATE time_entries
         SET ended_at = NOW(),
             minutes = GREATEST(1, EXTRACT(EPOCH FROM (NOW() - started_at))/60)::int,
             updated_at = NOW()
         WHERE id = $1 AND staff_id = $2 AND ended_at IS NULL RETURNING *`,
        [id, req.user.uid]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or already stopped" });
      res.json({ ok: true, entry: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Manual entry (already-completed time)
  app.post("/api/staff/time-entries", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const { client_key, task_id, description, minutes, hourly_rate_cents, billable, entry_date } = req.body || {};
      if (!description) return res.status(400).json({ ok: false, error: "description required" });
      const mins = parseInt(minutes, 10);
      if (!Number.isFinite(mins) || mins <= 0) {
        return res.status(400).json({ ok: false, error: "minutes must be a positive integer" });
      }
      const r = await db.query(
        `INSERT INTO time_entries
           (staff_id, client_key, task_id, description, minutes, hourly_rate_cents, billable, entry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE)) RETURNING *`,
        [req.user.uid,
         client_key || null,
         task_id ? parseInt(task_id, 10) : null,
         String(description).substring(0, 500),
         mins,
         hourly_rate_cents ? parseInt(hourly_rate_cents, 10) : null,
         billable !== false,
         entry_date || null]
      );
      res.json({ ok: true, entry: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // List time entries — mine by default, all if admin
  app.get("/api/staff/time-entries", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const scope = String(req.query.scope || "mine");
      const isAdmin = req.user.role === "admin";
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const params = [limit];
      let where = "1=1";
      if (scope === "mine" || !isAdmin) {
        params.push(req.user.uid);
        where += ` AND staff_id = $${params.length}`;
      }
      if (req.query.client_key) {
        params.push(String(req.query.client_key));
        where += ` AND client_key = $${params.length}`;
      }
      if (req.query.from) {
        params.push(String(req.query.from));
        where += ` AND entry_date >= $${params.length}::date`;
      }
      if (req.query.to) {
        params.push(String(req.query.to));
        where += ` AND entry_date <= $${params.length}::date`;
      }
      const r = await db.query(
        `SELECT t.*, a.full_name AS staff_name
         FROM time_entries t
         LEFT JOIN admin_users a ON a.id = t.staff_id
         WHERE ${where}
         ORDER BY t.entry_date DESC, t.started_at DESC NULLS LAST, t.id DESC
         LIMIT $1`,
        params
      );
      // Also return aggregate stats
      const totalMinutes = r.rows.reduce((s, x) => s + (x.minutes || 0), 0);
      const billableMinutes = r.rows.filter(x => x.billable).reduce((s, x) => s + (x.minutes || 0), 0);
      const totalCents = r.rows.reduce(
        (s, x) => s + Math.round(((x.minutes || 0) / 60) * (x.hourly_rate_cents || 0)),
        0
      );
      res.json({
        ok: true, entries: r.rows,
        summary: {
          total_minutes: totalMinutes,
          billable_minutes: billableMinutes,
          total_amount_cents: totalCents,
          entry_count: r.rows.length,
        },
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Time entries for a specific client
  app.get("/api/staff/clients/:key/time-entries", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const r = await db.query(
        `SELECT t.*, a.full_name AS staff_name
         FROM time_entries t
         LEFT JOIN admin_users a ON a.id = t.staff_id
         WHERE t.client_key = $1
         ORDER BY t.entry_date DESC, t.created_at DESC LIMIT 200`,
        [req.params.key]
      );
      const totalMinutes = r.rows.reduce((s, x) => s + (x.minutes || 0), 0);
      const billableMinutes = r.rows.filter(x => x.billable).reduce((s, x) => s + (x.minutes || 0), 0);
      const totalCents = r.rows.reduce(
        (s, x) => s + Math.round(((x.minutes || 0) / 60) * (x.hourly_rate_cents || 0)),
        0
      );
      res.json({
        ok: true, entries: r.rows,
        summary: {
          total_minutes: totalMinutes,
          billable_minutes: billableMinutes,
          total_amount_cents: totalCents,
          entry_count: r.rows.length,
        },
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Update a time entry
  app.patch("/api/staff/time-entries/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const fields = [];
      const params = [];
      let i = 1;
      for (const k of ["description", "minutes", "hourly_rate_cents", "billable", "entry_date", "client_key", "task_id"]) {
        if (req.body && req.body[k] !== undefined) {
          fields.push(`${k} = $${i++}`);
          params.push(req.body[k]);
        }
      }
      if (!fields.length) return res.status(400).json({ ok: false, error: "nothing to update" });
      fields.push("updated_at = NOW()");
      params.push(id, req.user.uid);
      const isAdmin = req.user.role === "admin";
      const where = isAdmin ? `id = $${i++}` : `id = $${i++} AND staff_id = $${i++}`;
      if (!isAdmin) { /* params already has user id at end */ }
      else params.pop();  // remove user id if admin
      const r = await db.query(
        `UPDATE time_entries SET ${fields.join(", ")} WHERE ${where} RETURNING *`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or not yours" });
      res.json({ ok: true, entry: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Delete a time entry
  app.delete("/api/staff/time-entries/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const isAdmin = req.user.role === "admin";
      const q = isAdmin
        ? `DELETE FROM time_entries WHERE id = $1 RETURNING id`
        : `DELETE FROM time_entries WHERE id = $1 AND staff_id = $2 RETURNING id`;
      const p = isAdmin ? [id] : [id, req.user.uid];
      const r = await db.query(q, p);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or not yours" });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ADMIN: outstanding invoices summary (for dashboard card)
  app.get("/api/staff/admin/invoices/summary", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT
           COUNT(*)::int AS count,
           COALESCE(SUM(amount_cents), 0)::bigint AS total_cents,
           COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < CURRENT_DATE THEN amount_cents ELSE 0 END), 0)::bigint AS overdue_cents,
           COUNT(CASE WHEN due_date IS NOT NULL AND due_date < CURRENT_DATE THEN 1 END)::int AS overdue_count,
           MIN(created_at) AS oldest_created_at
         FROM client_invoices WHERE status = 'sent'`
      );
      const row = r.rows[0];
      const oldestAge = row.oldest_created_at
        ? Math.floor((Date.now() - new Date(row.oldest_created_at).getTime()) / (24 * 60 * 60 * 1000))
        : 0;
      res.json({
        ok: true,
        summary: {
          count: row.count,
          total_cents: Number(row.total_cents),
          overdue_count: row.overdue_count,
          overdue_cents: Number(row.overdue_cents),
          oldest_days: oldestAge,
        },
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ADMIN: list all outstanding invoices with client names (for the summary drill-down)
  app.get("/api/staff/admin/invoices/outstanding", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT i.*,
                (SELECT client_name FROM tasks t WHERE t.client_key = i.client_key LIMIT 1) AS client_name
         FROM client_invoices i
         WHERE i.status = 'sent'
         ORDER BY (i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE) DESC, i.created_at ASC
         LIMIT 200`
      );
      res.json({ ok: true, invoices: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ADMIN: unbilled time entries for a client (to add to an invoice)
  app.get("/api/staff/clients/:key/time-entries/unbilled", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const r = await db.query(
        `SELECT t.*, a.full_name AS staff_name
         FROM time_entries t
         LEFT JOIN admin_users a ON a.id = t.staff_id
         WHERE t.client_key = $1
           AND t.billable = true
           AND t.invoice_id IS NULL
           AND t.ended_at IS NOT NULL  -- exclude running timers
         ORDER BY t.entry_date DESC`,
        [req.params.key]
      );
      const totalCents = r.rows.reduce(
        (s, x) => s + Math.round(((x.minutes || 0) / 60) * (x.hourly_rate_cents || 0)),
        0
      );
      res.json({
        ok: true,
        entries: r.rows,
        total_cents: totalCents,
        total_minutes: r.rows.reduce((s, x) => s + (x.minutes || 0), 0),
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CLIENT NOTES
  //  ─────────────────────────────────────────────────────
  //  Staff-only notes on clients (case strategy, personal context).
  //  All firm staff can view; only author or admin can edit/delete.
  //  Not visible to the client.
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/clients/:key/notes", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const r = await db.query(
        `SELECT n.*, a.full_name AS author_name
         FROM client_notes n
         LEFT JOIN admin_users a ON a.id = n.author_id
         WHERE n.client_key = $1
         ORDER BY n.pinned DESC, n.created_at DESC`,
        [req.params.key]
      );
      res.json({ ok: true, notes: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/staff/clients/:key/notes", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const body = String(req.body?.body || "").trim();
      if (!body) return res.status(400).json({ ok: false, error: "body required" });
      const r = await db.query(
        `INSERT INTO client_notes (client_key, author_id, body, pinned)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.params.key, req.user.uid, body.substring(0, 5000), !!req.body?.pinned]
      );
      const authorR = await db.query(`SELECT full_name FROM admin_users WHERE id = $1`, [req.user.uid]);
      res.json({ ok: true, note: { ...r.rows[0], author_name: authorR.rows[0]?.full_name } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/notes/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const isAdmin = req.user.role === "admin";
      const fields = [];
      const params = [];
      let i = 1;
      if (typeof req.body?.body === "string") {
        fields.push(`body = $${i++}`);
        params.push(String(req.body.body).substring(0, 5000));
      }
      if (typeof req.body?.pinned === "boolean") {
        fields.push(`pinned = $${i++}`);
        params.push(req.body.pinned);
      }
      if (!fields.length) return res.status(400).json({ ok: false, error: "nothing to update" });
      fields.push("updated_at = NOW()");
      params.push(id);
      let where = `id = $${i++}`;
      if (!isAdmin) {
        params.push(req.user.uid);
        where += ` AND author_id = $${i++}`;
      }
      const r = await db.query(
        `UPDATE client_notes SET ${fields.join(", ")} WHERE ${where} RETURNING *`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or not yours" });
      res.json({ ok: true, note: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.delete("/api/staff/notes/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const isAdmin = req.user.role === "admin";
      const q = isAdmin
        ? `DELETE FROM client_notes WHERE id = $1 RETURNING id`
        : `DELETE FROM client_notes WHERE id = $1 AND author_id = $2 RETURNING id`;
      const p = isAdmin ? [id] : [id, req.user.uid];
      const r = await db.query(q, p);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or not yours" });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  ATTORNEY SUITE
  //  ─────────────────────────────────────────────────────
  //  Document generator (templates + variable substitution),
  //  CLE credit tracker (CA requirements), and court-date
  //  prep checklists (attach items to a court task).
  // ═══════════════════════════════════════════════════════

  // Document templates — list all
  app.get("/api/staff/document-templates", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, slug, name, category, description, variables, created_at
         FROM document_templates
         ORDER BY category, name`
      );
      res.json({ ok: true, templates: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Get single template with body
  app.get("/api/staff/document-templates/:slug", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT * FROM document_templates WHERE slug = $1`,
        [String(req.params.slug)]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "template not found" });
      res.json({ ok: true, template: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Generate a document by filling in variables
  app.post("/api/staff/documents/generate", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const { template_slug, variables, client_key, title, save_to_client_documents } = req.body || {};
      if (!template_slug || !variables || typeof variables !== 'object') {
        return res.status(400).json({ ok: false, error: "template_slug and variables required" });
      }
      const tR = await db.query(`SELECT * FROM document_templates WHERE slug = $1`, [String(template_slug)]);
      const tpl = tR.rows[0];
      if (!tpl) return res.status(404).json({ ok: false, error: "template not found" });

      // Substitute {variable_name} placeholders in body
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const allVars = { ...variables, today_date: today };
      let body = tpl.body;
      for (const [key, value] of Object.entries(allVars)) {
        const safe = String(value ?? '').replace(/\$/g, '$$$$'); // escape $ for replace
        body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), safe);
      }

      const finalTitle = String(title || `${tpl.name} — ${variables.client_name || 'Untitled'}`).substring(0, 300);
      const saved = await db.query(
        `INSERT INTO generated_documents
           (client_key, template_slug, template_name, title, body, variables, generated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [client_key || null, template_slug, tpl.name, finalTitle, body, JSON.stringify(allVars), req.user.uid]
      );

      // Optionally save a copy to client_documents (searchable by client)
      if (save_to_client_documents && client_key) {
        try {
          await db.query(
            `INSERT INTO client_documents
               (client_key, filename, mime_type, size_bytes, category, note, content, uploaded_by)
             VALUES ($1, $2, 'text/plain', $3, 'legal_document', $4, $5, 'firm')`,
            [
              String(client_key),
              `${finalTitle}.txt`,
              Buffer.byteLength(body, 'utf8'),
              `Generated from template: ${tpl.name}`,
              Buffer.from(body, 'utf8'),
            ]
          );
        } catch (e) { console.warn("[doc gen] save to client_documents failed:", e.message); }
      }

      res.json({ ok: true, document: saved.rows[0] });
    } catch (err) {
      console.error("[doc generate]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // List generated documents (mine, or all for admin)
  app.get("/api/staff/documents/generated", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const scope = String(req.query.scope || "mine");
      const isAdmin = req.user.r === "admin";
      const clientKey = req.query.client_key;
      const params = [];
      let where = "1=1";
      if ((scope === "mine" || !isAdmin) && !clientKey) {
        params.push(req.user.uid);
        where += ` AND generated_by = $${params.length}`;
      }
      if (clientKey) {
        const ok = await canUserAccessClient(req.user, String(clientKey));
        if (!ok) return res.status(403).json({ ok: false, error: "no access" });
        params.push(String(clientKey));
        where += ` AND client_key = $${params.length}`;
      }
      const r = await db.query(
        `SELECT g.id, g.client_key, g.template_slug, g.template_name, g.title,
                g.generated_by, g.created_at,
                a.full_name AS generated_by_name
         FROM generated_documents g
         LEFT JOIN admin_users a ON a.id = g.generated_by
         WHERE ${where}
         ORDER BY g.created_at DESC
         LIMIT 100`,
        params
      );
      res.json({ ok: true, documents: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Get single generated document (with body)
  app.get("/api/staff/documents/generated/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(`SELECT * FROM generated_documents WHERE id = $1`, [id]);
      const doc = r.rows[0];
      if (!doc) return res.status(404).json({ ok: false, error: "not found" });
      // Access check: creator, admin, or has access to client
      const canAccess = doc.generated_by === req.user.uid
        || req.user.r === "admin"
        || (doc.client_key && await canUserAccessClient(req.user, doc.client_key));
      if (!canAccess) return res.status(403).json({ ok: false, error: "no access" });
      res.json({ ok: true, document: doc });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── CLE Credits ─────────────────────────────────────
  // California requirements (25 hrs / 3 yrs, 4 ethics, 1 competence, 1 elimination-of-bias, 1 tech)

  app.get("/api/staff/cle-credits", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT * FROM cle_credits WHERE attorney_id = $1 ORDER BY credit_date DESC`,
        [req.user.uid]
      );
      // Compute summary for current 3-year period
      const now = new Date();
      const threeYearsAgo = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate());
      const inWindow = r.rows.filter(x => new Date(x.credit_date) >= threeYearsAgo);
      const sum = (field) => inWindow.reduce((s, x) => s + Number(x[field] || 0), 0);
      res.json({
        ok: true,
        credits: r.rows,
        summary: {
          window_start: threeYearsAgo.toISOString().substring(0, 10),
          window_end: now.toISOString().substring(0, 10),
          total_hours: sum("hours"),
          ethics_hours: sum("ethics_hours"),
          competence_hours: sum("competence_hours"),
          bias_hours: sum("bias_hours"),
          tech_hours: sum("tech_hours"),
          ca_requirements: {
            total_needed: 25,
            ethics_needed: 4,
            competence_needed: 1,
            bias_needed: 1,
            tech_needed: 1,
          },
        },
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/staff/cle-credits", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const { provider, subject, hours, ethics_hours, competence_hours, bias_hours, tech_hours,
              credit_date, compliance_period, notes, certificate_url } = req.body || {};
      if (!provider || !subject || !hours || !credit_date) {
        return res.status(400).json({ ok: false, error: "provider, subject, hours, credit_date required" });
      }
      const hrs = parseFloat(hours);
      if (!Number.isFinite(hrs) || hrs <= 0) {
        return res.status(400).json({ ok: false, error: "hours must be a positive number" });
      }
      const r = await db.query(
        `INSERT INTO cle_credits
           (attorney_id, provider, subject, hours, ethics_hours, competence_hours, bias_hours, tech_hours,
            credit_date, compliance_period, notes, certificate_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          req.user.uid,
          String(provider).substring(0, 200),
          String(subject).substring(0, 300),
          hrs,
          parseFloat(ethics_hours) || 0,
          parseFloat(competence_hours) || 0,
          parseFloat(bias_hours) || 0,
          parseFloat(tech_hours) || 0,
          credit_date,
          compliance_period ? String(compliance_period).substring(0, 40) : null,
          notes ? String(notes).substring(0, 1000) : null,
          certificate_url ? String(certificate_url).substring(0, 500) : null,
        ]
      );
      res.json({ ok: true, credit: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/cle-credits/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const fields = [];
      const params = [];
      let i = 1;
      for (const k of ["provider", "subject", "hours", "ethics_hours", "competence_hours",
                       "bias_hours", "tech_hours", "credit_date", "compliance_period",
                       "notes", "certificate_url"]) {
        if (req.body && req.body[k] !== undefined) {
          fields.push(`${k} = $${i++}`);
          params.push(req.body[k]);
        }
      }
      if (!fields.length) return res.status(400).json({ ok: false, error: "nothing to update" });
      params.push(id, req.user.uid);
      const r = await db.query(
        `UPDATE cle_credits SET ${fields.join(", ")}
         WHERE id = $${i++} AND attorney_id = $${i++} RETURNING *`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, credit: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.delete("/api/staff/cle-credits/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `DELETE FROM cle_credits WHERE id = $1 AND attorney_id = $2 RETURNING id`,
        [id, req.user.uid]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Court Prep Checklists ───────────────────────────

  app.get("/api/staff/tasks/:id/prep-items", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `SELECT * FROM court_prep_items WHERE task_id = $1 ORDER BY position ASC, id ASC`,
        [id]
      );
      res.json({ ok: true, items: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/staff/tasks/:id/prep-items", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const taskId = parseInt(req.params.id, 10);
      if (!Number.isFinite(taskId)) return res.status(400).json({ ok: false, error: "bad task id" });
      const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
      const results = [];
      for (const item of items) {
        if (!item?.item_text || typeof item.item_text !== "string") continue;
        const posR = await db.query(
          `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM court_prep_items WHERE task_id = $1`,
          [taskId]
        );
        const r = await db.query(
          `INSERT INTO court_prep_items (task_id, item_text, position) VALUES ($1, $2, $3) RETURNING *`,
          [taskId, String(item.item_text).substring(0, 500), posR.rows[0].next]
        );
        results.push(r.rows[0]);
      }
      res.json({ ok: true, items: results });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/prep-items/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const fields = [];
      const params = [];
      let i = 1;
      if (typeof req.body?.completed === "boolean") {
        fields.push(`completed = $${i++}`);
        params.push(req.body.completed);
      }
      if (typeof req.body?.item_text === "string") {
        fields.push(`item_text = $${i++}`);
        params.push(String(req.body.item_text).substring(0, 500));
      }
      if (Number.isFinite(parseInt(req.body?.position, 10))) {
        fields.push(`position = $${i++}`);
        params.push(parseInt(req.body.position, 10));
      }
      if (!fields.length) return res.status(400).json({ ok: false, error: "nothing to update" });
      fields.push("updated_at = NOW()");
      params.push(id);
      const r = await db.query(
        `UPDATE court_prep_items SET ${fields.join(", ")} WHERE id = $${i++} RETURNING *`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, item: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.delete("/api/staff/prep-items/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      await db.query(`DELETE FROM court_prep_items WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  GLOBAL SEARCH (fuzzy)
  //  ─────────────────────────────────────────────────────
  //  Multi-word tokenized search across clients, tasks, invoices, notes.
  //  - Splits query into words: all words must match (AND)
  //  - Case-insensitive, diacritic-insensitive (best-effort)
  //  - Phone: strips non-digits, matches partial digit sequences
  //  - Searches case_members (riders) — matching a spouse or child
  //    surfaces the main respondent's case
  //  - Handles client_aliases (merged old client_keys still findable)
  // ═══════════════════════════════════════════════════════

  // Normalize a search term: lowercase, strip diacritics (best-effort)
  function normalizeTerm(s) {
    return String(s || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // strip combining diacritics
      .replace(/\s+/g, " ").trim();
  }
  function extractDigits(s) {
    return String(s || "").replace(/\D/g, "");
  }

  app.get("/api/staff/search", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const rawQ = String(req.query.q || "").trim();
      if (!rawQ || rawQ.length < 2) {
        return res.json({ ok: true, results: { clients: [], tasks: [], invoices: [], notes: [] } });
      }
      const qNorm = normalizeTerm(rawQ);
      const words = qNorm.split(" ").filter(w => w.length >= 2);
      if (!words.length) return res.json({ ok: true, results: { clients: [], tasks: [], invoices: [], notes: [] } });

      // Digit-only version of query for phone matching
      const qDigits = extractDigits(rawQ);
      const looksLikePhone = qDigits.length >= 3;

      // Build AND-of-ORs for word matching across name/phone/email/matter/a_number
      // Also match against case_members.full_name (rider names)
      const clientParams = [];
      const clientClauses = [];
      for (const w of words) {
        clientParams.push(`%${w}%`);
        const wp = `$${clientParams.length}`;
        clientClauses.push(`(
          LOWER(client_name) LIKE ${wp}
          OR LOWER(COALESCE(client_email, '')) LIKE ${wp}
          OR LOWER(COALESCE(matter_type, '')) LIKE ${wp}
          OR LOWER(COALESCE(a_number, '')) LIKE ${wp}
          OR client_key IN (
            SELECT client_key FROM case_members WHERE LOWER(full_name) LIKE ${wp}
          )
        )`);
      }
      // Add phone-digit clause if applicable
      let phoneClause = "";
      if (looksLikePhone) {
        clientParams.push(`%${qDigits}%`);
        const dp = `$${clientParams.length}`;
        phoneClause = ` OR REGEXP_REPLACE(COALESCE(client_phone, ''), '\\D', '', 'g') LIKE ${dp}`;
      }
      const finalWhere = `(${clientClauses.join(" AND ")})${phoneClause}`;

      const [clientsR, tasksR, invoicesR, notesR, membersR] = await Promise.all([
        db.query(
          `SELECT DISTINCT client_key, client_name, client_phone, client_email, matter_type, a_number
           FROM tasks WHERE ${finalWhere}
           LIMIT 20`, clientParams
        ),
        db.query(
          `SELECT id, description, client_name, client_key, matter_type, due_date, completed
           FROM tasks WHERE ${clientClauses.map((c, i) => c.replace(/client_key IN.*?\)/, '1=1')).join(' AND ')}
              OR (${clientClauses.map(c => c.replace(/LOWER\(client_name\)/, 'LOWER(description)')).join(' AND ')})
           ORDER BY (completed IS NULL OR completed = false) DESC, due_date ASC NULLS LAST
           LIMIT 15`, clientParams.slice(0, words.length)
        ).catch(async () => {
          // Fallback: simple substring match for descriptions
          return db.query(
            `SELECT id, description, client_name, client_key, matter_type, due_date, completed
             FROM tasks WHERE LOWER(description) LIKE $1
             ORDER BY (completed IS NULL OR completed = false) DESC, due_date ASC NULLS LAST
             LIMIT 15`, [`%${qNorm}%`]
          );
        }),
        db.query(
          `SELECT i.id, i.description, i.amount_cents, i.status, i.client_key,
                  (SELECT client_name FROM tasks t WHERE t.client_key = i.client_key LIMIT 1) AS client_name
           FROM client_invoices i
           WHERE LOWER(i.description) LIKE $1
              OR i.client_key IN (SELECT DISTINCT client_key FROM tasks WHERE ${clientClauses.map((c,i) => c).join(' AND ')})
           ORDER BY i.created_at DESC LIMIT 15`,
          [`%${qNorm}%`, ...clientParams.slice(0, words.length)]
        ).catch(async () => db.query(
          `SELECT i.id, i.description, i.amount_cents, i.status, i.client_key,
                  (SELECT client_name FROM tasks t WHERE t.client_key = i.client_key LIMIT 1) AS client_name
           FROM client_invoices i WHERE LOWER(i.description) LIKE $1
           ORDER BY i.created_at DESC LIMIT 15`, [`%${qNorm}%`])),
        db.query(
          `SELECT n.id, n.client_key, n.body, n.created_at,
                  a.full_name AS author_name,
                  (SELECT client_name FROM tasks t WHERE t.client_key = n.client_key LIMIT 1) AS client_name
           FROM client_notes n
           LEFT JOIN admin_users a ON a.id = n.author_id
           WHERE LOWER(n.body) LIKE $1
           ORDER BY n.created_at DESC LIMIT 10`, [`%${qNorm}%`]
        ),
        // Also search case_members directly — return the case they belong to
        db.query(
          `SELECT m.client_key, m.full_name AS member_name, m.relationship, m.a_number,
                  (SELECT client_name FROM tasks t WHERE t.client_key = m.client_key LIMIT 1) AS main_client_name,
                  (SELECT matter_type FROM tasks t WHERE t.client_key = m.client_key LIMIT 1) AS matter_type
           FROM case_members m
           WHERE LOWER(m.full_name) LIKE $1 OR LOWER(COALESCE(m.a_number, '')) LIKE $1
           LIMIT 10`, [`%${qNorm}%`]
        ),
      ]);

      // Combine rider matches into client results (dedup by client_key)
      const seenKeys = new Set(clientsR.rows.map(c => c.client_key));
      const memberClientRows = [];
      for (const m of membersR.rows) {
        if (seenKeys.has(m.client_key)) continue;
        seenKeys.add(m.client_key);
        memberClientRows.push({
          client_key: m.client_key,
          client_name: m.main_client_name || '(unnamed case)',
          matter_type: m.matter_type,
          matched_rider: `${m.full_name} (${m.relationship})`,
        });
      }

      res.json({
        ok: true,
        query: rawQ,
        results: {
          clients: [...clientsR.rows, ...memberClientRows],
          tasks: tasksR.rows,
          invoices: invoicesR.rows,
          notes: notesR.rows,
        },
      });
    } catch (err) {
      console.error("[search]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  CASE MEMBERS (Riders / Family Beneficiaries)
  //  ─────────────────────────────────────────────────────
  //  A single case can have a main respondent + multiple family
  //  members (spouse, minor children, parents) as "riders."
  //  All members share the case's client_key. Searching for any
  //  rider name will surface the main case.
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/clients/:key/members", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const r = await db.query(
        `SELECT m.*, a.full_name AS added_by_name
         FROM case_members m LEFT JOIN admin_users a ON a.id = m.added_by
         WHERE m.client_key = $1
         ORDER BY (is_primary DESC), relationship, full_name`,
        [req.params.key]
      );
      res.json({ ok: true, members: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/staff/clients/:key/members", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const { full_name, relationship, a_number, dob, is_primary, notes } = req.body || {};
      if (!full_name || !String(full_name).trim()) {
        return res.status(400).json({ ok: false, error: "full_name required" });
      }
      const validRels = ['self', 'spouse', 'child', 'parent', 'sibling', 'other'];
      const rel = validRels.includes(relationship) ? relationship : 'other';
      // If this is being set as primary, unset any existing primary
      if (is_primary) {
        await db.query(`UPDATE case_members SET is_primary = false WHERE client_key = $1`, [req.params.key]);
      }
      const r = await db.query(
        `INSERT INTO case_members
           (client_key, full_name, relationship, a_number, dob, is_primary, notes, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.params.key,
         String(full_name).trim().substring(0, 200),
         rel,
         a_number ? String(a_number).trim().substring(0, 20) : null,
         dob || null,
         !!is_primary,
         notes ? String(notes).substring(0, 1000) : null,
         req.user.uid]
      );
      res.json({ ok: true, member: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/members/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const orig = await db.query(`SELECT client_key FROM case_members WHERE id = $1`, [id]);
      if (!orig.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      const ok = await canUserAccessClient(req.user, orig.rows[0].client_key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const fields = [];
      const params = [];
      let i = 1;
      for (const k of ['full_name', 'relationship', 'a_number', 'dob', 'is_primary', 'notes']) {
        if (req.body && req.body[k] !== undefined) {
          fields.push(`${k} = $${i++}`);
          params.push(req.body[k]);
        }
      }
      if (!fields.length) return res.status(400).json({ ok: false, error: "nothing to update" });
      fields.push("updated_at = NOW()");
      params.push(id);
      const r = await db.query(
        `UPDATE case_members SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
        params
      );
      res.json({ ok: true, member: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.delete("/api/staff/members/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const orig = await db.query(`SELECT client_key FROM case_members WHERE id = $1`, [id]);
      if (!orig.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      const ok = await canUserAccessClient(req.user, orig.rows[0].client_key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      await db.query(`DELETE FROM case_members WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CLIENT MERGE (admin only)
  //  ─────────────────────────────────────────────────────
  //  Merges TWO client_keys into ONE. All tasks, invoices, notes,
  //  time entries, trust transactions, documents, and case members
  //  from SOURCE move to TARGET. Source is recorded as an alias so
  //  old references still work.
  // ═══════════════════════════════════════════════════════

  app.post("/api/staff/admin/clients/merge", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const { source_key, target_key } = req.body || {};
      if (!source_key || !target_key) {
        return res.status(400).json({ ok: false, error: "source_key and target_key required" });
      }
      if (source_key === target_key) {
        return res.status(400).json({ ok: false, error: "cannot merge a client into itself" });
      }
      // Get the source name for the alias record
      const nameR = await db.query(
        `SELECT DISTINCT client_name FROM tasks WHERE client_key = $1 LIMIT 1`,
        [source_key]
      );
      const sourceName = nameR.rows[0]?.client_name || source_key;

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Move all data from source to target
        const updates = [
          `UPDATE tasks SET client_key = $2 WHERE client_key = $1`,
          `UPDATE client_invoices SET client_key = $2 WHERE client_key = $1`,
          `UPDATE client_notes SET client_key = $2 WHERE client_key = $1`,
          `UPDATE client_documents SET client_key = $2 WHERE client_key = $1`,
          `UPDATE time_entries SET client_key = $2 WHERE client_key = $1`,
          `UPDATE trust_transactions SET client_key = $2 WHERE client_key = $1`,
          `UPDATE case_members SET client_key = $2 WHERE client_key = $1`,
          `UPDATE client_messages SET client_key = $2 WHERE client_key = $1`,
          `UPDATE client_consultants SET client_key = $2 WHERE client_key = $1`,
        ];
        const results = {};
        for (const q of updates) {
          try {
            const r = await client.query(q, [source_key, target_key]);
            const table = q.match(/UPDATE (\w+)/)[1];
            results[table] = r.rowCount || 0;
          } catch (e) {
            // Some tables might not exist yet; skip silently
            console.warn(`[merge] skipped table:`, e.message);
          }
        }
        // Record the alias so old refs still work
        await client.query(
          `INSERT INTO client_aliases (canonical_key, alias_key, alias_name, merged_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (alias_key) DO UPDATE SET canonical_key = $1, merged_at = NOW()`,
          [target_key, source_key, sourceName, req.user.uid]
        );
        await client.query('COMMIT');
        res.json({
          ok: true,
          source_key,
          target_key,
          moved: results,
          message: `Merged ${sourceName} into target.`,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[merge]:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Suggest possible duplicates for a client (based on similar names/phones/emails)
  app.get("/api/staff/admin/clients/:key/possible-duplicates", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const key = req.params.key;
      // Get this client's info
      const self = await db.query(
        `SELECT DISTINCT client_name, client_phone, client_email, matter_type
         FROM tasks WHERE client_key = $1 LIMIT 1`,
        [key]
      );
      if (!self.rows[0]) return res.json({ ok: true, duplicates: [] });
      const c = self.rows[0];
      const dupes = new Map();
      // Match by same phone (normalized)
      if (c.client_phone) {
        const digits = extractDigits(c.client_phone);
        if (digits.length >= 7) {
          const r = await db.query(
            `SELECT DISTINCT client_key, client_name, client_phone, client_email
             FROM tasks WHERE client_key != $1
               AND REGEXP_REPLACE(COALESCE(client_phone, ''), '\\D', '', 'g') LIKE $2
             LIMIT 10`,
            [key, `%${digits.substring(digits.length - 10)}%`]
          );
          for (const row of r.rows) dupes.set(row.client_key, { ...row, reason: 'same phone' });
        }
      }
      // Match by same email
      if (c.client_email) {
        const r = await db.query(
          `SELECT DISTINCT client_key, client_name, client_phone, client_email
           FROM tasks WHERE client_key != $1 AND LOWER(client_email) = LOWER($2) LIMIT 10`,
          [key, c.client_email]
        );
        for (const row of r.rows) {
          const prev = dupes.get(row.client_key);
          dupes.set(row.client_key, { ...row, reason: prev ? 'same phone + email' : 'same email' });
        }
      }
      // Match by name similarity (starts-with or contains major word)
      if (c.client_name) {
        const words = normalizeTerm(c.client_name).split(" ").filter(w => w.length >= 3);
        if (words.length) {
          const params = [key];
          const clauses = words.map(w => {
            params.push(`%${w}%`);
            return `LOWER(client_name) LIKE $${params.length}`;
          });
          const r = await db.query(
            `SELECT DISTINCT client_key, client_name, client_phone, client_email
             FROM tasks WHERE client_key != $1 AND (${clauses.join(' AND ')})
             LIMIT 10`,
            params
          );
          for (const row of r.rows) {
            const prev = dupes.get(row.client_key);
            if (!prev) dupes.set(row.client_key, { ...row, reason: 'similar name' });
          }
        }
      }
      res.json({ ok: true, source_client: c, duplicates: Array.from(dupes.values()) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Firm-wide duplicate sweep: return clusters of clients that likely
  // represent the same person. Groups by normalized phone digits primarily,
  // then by exact email, then by first+last name match.
  app.get("/api/staff/admin/duplicate-sweep", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      // Get all distinct clients with normalized data
      const allR = await db.query(
        `SELECT DISTINCT client_key, client_name, client_phone, client_email, matter_type,
                MAX(created_at) OVER (PARTITION BY client_key) AS last_activity
         FROM tasks
         WHERE client_key IS NOT NULL
           AND client_key NOT IN (SELECT alias_key FROM client_aliases)
         ORDER BY client_name`
      );
      const rows = allR.rows;
      // Build clusters
      const clusters = [];
      const seen = new Set();
      for (const row of rows) {
        if (seen.has(row.client_key)) continue;
        const cluster = { members: [row], reasons: new Set() };
        seen.add(row.client_key);

        // Match by phone digits (>=7 significant digits)
        if (row.client_phone) {
          const digits = extractDigits(row.client_phone);
          if (digits.length >= 7) {
            const last10 = digits.substring(digits.length - 10);
            for (const other of rows) {
              if (seen.has(other.client_key) || other.client_key === row.client_key) continue;
              if (!other.client_phone) continue;
              const otherDigits = extractDigits(other.client_phone);
              if (otherDigits.length >= 7 && otherDigits.substring(otherDigits.length - 10) === last10) {
                cluster.members.push(other);
                seen.add(other.client_key);
                cluster.reasons.add('same phone');
              }
            }
          }
        }
        // Match by exact email
        if (row.client_email) {
          const emailLc = row.client_email.toLowerCase().trim();
          for (const other of rows) {
            if (seen.has(other.client_key) || other.client_key === row.client_key) continue;
            if (other.client_email && other.client_email.toLowerCase().trim() === emailLc) {
              cluster.members.push(other);
              seen.add(other.client_key);
              cluster.reasons.add('same email');
            }
          }
        }
        // Match by first+last name (both present, both matching)
        if (row.client_name) {
          const words = normalizeTerm(row.client_name).split(' ').filter(w => w.length >= 3);
          if (words.length >= 2) {
            const first = words[0], last = words[words.length - 1];
            for (const other of rows) {
              if (seen.has(other.client_key) || other.client_key === row.client_key) continue;
              if (!other.client_name) continue;
              const otherNorm = normalizeTerm(other.client_name);
              if (otherNorm.includes(first) && otherNorm.includes(last)) {
                cluster.members.push(other);
                seen.add(other.client_key);
                cluster.reasons.add('similar name');
              }
            }
          }
        }
        if (cluster.members.length > 1) {
          // Enrich with counts
          for (const m of cluster.members) {
            const cts = await db.query(
              `SELECT
                 (SELECT COUNT(*)::int FROM tasks WHERE client_key = $1) AS task_count,
                 (SELECT COUNT(*)::int FROM client_invoices WHERE client_key = $1) AS invoice_count,
                 (SELECT COUNT(*)::int FROM client_notes WHERE client_key = $1) AS note_count,
                 (SELECT COUNT(*)::int FROM client_documents WHERE client_key = $1) AS doc_count,
                 (SELECT COALESCE(SUM(amount_cents), 0)::int FROM client_invoices WHERE client_key = $1) AS invoice_cents`,
              [m.client_key]
            );
            Object.assign(m, cts.rows[0]);
          }
          clusters.push({
            reasons: Array.from(cluster.reasons),
            members: cluster.members,
          });
        }
      }
      res.json({
        ok: true,
        total_clients: rows.length,
        duplicate_clusters: clusters.length,
        duplicate_clients_total: clusters.reduce((s, c) => s + c.members.length, 0),
        clusters,
      });
    } catch (err) {
      console.error("[sweep]:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  CASE TIMELINE (aggregated activity for a client)
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/clients/:key/timeline", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const key = req.params.key;
      const [messages, docs, invoices, notes, timeEntries, tasks] = await Promise.all([
        db.query(
          `SELECT id, body, from_who, created_at
           FROM client_messages WHERE client_key = $1 ORDER BY created_at DESC LIMIT 50`, [key]
        ).catch(() => ({ rows: [] })),
        db.query(
          `SELECT id, filename, category, uploaded_at, uploaded_by
           FROM client_documents WHERE client_key = $1 ORDER BY uploaded_at DESC LIMIT 50`, [key]
        ).catch(() => ({ rows: [] })),
        db.query(
          `SELECT id, description, amount_cents, status, paid_at, created_at
           FROM client_invoices WHERE client_key = $1 ORDER BY created_at DESC LIMIT 50`, [key]
        ).catch(() => ({ rows: [] })),
        db.query(
          `SELECT n.id, n.body, n.pinned, n.created_at, a.full_name AS author_name
           FROM client_notes n LEFT JOIN admin_users a ON a.id = n.author_id
           WHERE n.client_key = $1 ORDER BY n.created_at DESC LIMIT 50`, [key]
        ).catch(() => ({ rows: [] })),
        db.query(
          `SELECT t.id, t.description, t.minutes, t.billable, t.entry_date, a.full_name AS staff_name
           FROM time_entries t LEFT JOIN admin_users a ON a.id = t.staff_id
           WHERE t.client_key = $1 ORDER BY t.entry_date DESC LIMIT 50`, [key]
        ).catch(() => ({ rows: [] })),
        db.query(
          `SELECT id, description, due_date, completed, created_at, updated_at
           FROM tasks WHERE client_key = $1 ORDER BY created_at DESC LIMIT 50`, [key]
        ).catch(() => ({ rows: [] })),
      ]);
      // Build a chronologically merged event feed
      const events = [];
      for (const m of messages.rows) {
        events.push({
          type: "message", id: `msg-${m.id}`,
          at: m.created_at,
          summary: `${m.from_who === "firm" ? "Firm" : "Client"}: ${String(m.body || "").substring(0, 100)}`,
          data: m,
        });
      }
      for (const d of docs.rows) {
        events.push({
          type: "document", id: `doc-${d.id}`, at: d.uploaded_at,
          summary: `${d.uploaded_by === "client" ? "Client" : "Firm"} uploaded ${d.filename} (${d.category})`,
          data: d,
        });
      }
      for (const i of invoices.rows) {
        events.push({
          type: "invoice", id: `inv-${i.id}`, at: i.created_at,
          summary: `Invoice #${i.id}: $${(i.amount_cents / 100).toFixed(2)} — ${i.description}${i.status === "paid" ? " (PAID)" : ""}`,
          data: i,
        });
      }
      for (const n of notes.rows) {
        events.push({
          type: "note", id: `note-${n.id}`, at: n.created_at,
          summary: `${n.author_name || "Staff"} noted: ${String(n.body).substring(0, 100)}`,
          data: n,
        });
      }
      for (const t of timeEntries.rows) {
        events.push({
          type: "time", id: `time-${t.id}`, at: t.entry_date,
          summary: `${t.staff_name || "Staff"} logged ${t.minutes || 0} min: ${t.description}`,
          data: t,
        });
      }
      for (const t of tasks.rows) {
        events.push({
          type: "task", id: `task-${t.id}`, at: t.created_at,
          summary: `Task: ${t.description}${t.completed ? " (done)" : ""}`,
          data: t,
        });
      }
      events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      res.json({ ok: true, events: events.slice(0, 100) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  ATTORNEY SUITE
  //  ─────────────────────────────────────────────────────
  //  Document Generator, CLE Tracker, Court Prep Checklists.
  //  Available to admin + attorney roles (paralegals can view CLE only).
  // ═══════════════════════════════════════════════════════

  // ── Document Templates ──────────────────────────────────

  // List all templates (all firm users)
  app.get("/api/staff/document-templates", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, slug, name, category, description, variables, updated_at
         FROM document_templates ORDER BY category, name`
      );
      res.json({ ok: true, templates: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Get single template with body
  app.get("/api/staff/document-templates/:slug", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT * FROM document_templates WHERE slug = $1`,
        [String(req.params.slug)]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, template: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Generate a document from a template — fills in variables and saves
  app.post("/api/staff/documents/generate", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const { template_slug, variables, client_key, title, attach_to_client } = req.body || {};
      if (!template_slug) return res.status(400).json({ ok: false, error: "template_slug required" });
      const tR = await db.query(`SELECT * FROM document_templates WHERE slug = $1`, [String(template_slug)]);
      const tmpl = tR.rows[0];
      if (!tmpl) return res.status(404).json({ ok: false, error: "template not found" });
      const vars = variables || {};
      // Always inject today_date
      vars.today_date = vars.today_date || new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      // Substitute {var_name} in template body
      let body = String(tmpl.body);
      body = body.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, key) => {
        return vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : m;
      });
      const finalTitle = String(title || tmpl.name).substring(0, 200);
      const gR = await db.query(
        `INSERT INTO generated_documents
           (client_key, template_slug, template_name, title, body, variables, generated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [client_key || null, tmpl.slug, tmpl.name, finalTitle, body, JSON.stringify(vars), req.user.uid]
      );
      // Optionally attach as a client document (as text/plain)
      if (attach_to_client && client_key) {
        try {
          const buf = Buffer.from(body, 'utf-8');
          await db.query(
            `INSERT INTO client_documents (client_key, filename, mime_type, size_bytes, category, note, content, uploaded_by)
             VALUES ($1, $2, 'text/plain', $3, 'legal_document', $4, $5, $6)`,
            [String(client_key), `${finalTitle}.txt`, buf.length, `Generated from ${tmpl.name}`, buf, `staff:${req.user.uid}`]
          );
        } catch (e) { console.warn("[doc attach]:", e.message); }
      }
      res.json({ ok: true, document: gR.rows[0] });
    } catch (err) {
      console.error("[document generate]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // List generated documents (mine, or by client, or all if admin)
  app.get("/api/staff/documents/generated", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const isAdminUser = req.user.r === "admin";
      const params = [];
      let where = "1=1";
      const scope = String(req.query.scope || "mine");
      if (scope === "mine" || !isAdminUser) {
        params.push(req.user.uid);
        where += ` AND generated_by = $${params.length}`;
      }
      if (req.query.client_key) {
        params.push(String(req.query.client_key));
        where += ` AND client_key = $${params.length}`;
      }
      const r = await db.query(
        `SELECT g.id, g.client_key, g.template_slug, g.template_name, g.title, g.created_at,
                a.full_name AS generated_by_name,
                (SELECT client_name FROM tasks t WHERE t.client_key = g.client_key LIMIT 1) AS client_name
         FROM generated_documents g
         LEFT JOIN admin_users a ON a.id = g.generated_by
         WHERE ${where}
         ORDER BY g.created_at DESC LIMIT 100`,
        params
      );
      res.json({ ok: true, documents: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Get a generated document's full body
  app.get("/api/staff/documents/generated/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(`SELECT * FROM generated_documents WHERE id = $1`, [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      // Access check via client
      if (r.rows[0].client_key) {
        const ok = await canUserAccessClient(req.user, r.rows[0].client_key);
        if (!ok && r.rows[0].generated_by !== req.user.uid) {
          return res.status(403).json({ ok: false, error: "no access" });
        }
      }
      res.json({ ok: true, document: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Delete a generated document (author or admin)
  app.delete("/api/staff/documents/generated/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const isAdminUser = req.user.r === "admin";
      const q = isAdminUser
        ? `DELETE FROM generated_documents WHERE id = $1 RETURNING id`
        : `DELETE FROM generated_documents WHERE id = $1 AND generated_by = $2 RETURNING id`;
      const p = isAdminUser ? [id] : [id, req.user.uid];
      const r = await db.query(q, p);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or not yours" });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── CLE Credits ──────────────────────────────────────────

  app.get("/api/staff/cle-credits", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT * FROM cle_credits WHERE attorney_id = $1 ORDER BY credit_date DESC`,
        [req.user.uid]
      );
      res.json({ ok: true, credits: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/staff/cle-credits", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const { provider, subject, hours, ethics_hours, competence_hours, bias_hours, tech_hours,
              credit_date, compliance_period, notes, certificate_url } = req.body || {};
      if (!provider || !subject || !hours || !credit_date) {
        return res.status(400).json({ ok: false, error: "provider, subject, hours, credit_date required" });
      }
      const r = await db.query(
        `INSERT INTO cle_credits
           (attorney_id, provider, subject, hours, ethics_hours, competence_hours, bias_hours, tech_hours,
            credit_date, compliance_period, notes, certificate_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [req.user.uid, String(provider).substring(0, 200), String(subject).substring(0, 300),
         Number(hours) || 0, Number(ethics_hours) || 0, Number(competence_hours) || 0,
         Number(bias_hours) || 0, Number(tech_hours) || 0,
         credit_date, compliance_period ? String(compliance_period).substring(0, 40) : null,
         notes ? String(notes).substring(0, 1000) : null,
         certificate_url ? String(certificate_url).substring(0, 500) : null]
      );
      res.json({ ok: true, credit: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/cle-credits/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const fields = [];
      const params = [];
      let i = 1;
      for (const k of ["provider", "subject", "hours", "ethics_hours", "competence_hours", "bias_hours",
                       "tech_hours", "credit_date", "compliance_period", "notes", "certificate_url"]) {
        if (req.body && req.body[k] !== undefined) {
          fields.push(`${k} = $${i++}`);
          params.push(req.body[k]);
        }
      }
      if (!fields.length) return res.status(400).json({ ok: false, error: "nothing to update" });
      params.push(id, req.user.uid);
      const r = await db.query(
        `UPDATE cle_credits SET ${fields.join(", ")} WHERE id = $${i++} AND attorney_id = $${i++} RETURNING *`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or not yours" });
      res.json({ ok: true, credit: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.delete("/api/staff/cle-credits/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `DELETE FROM cle_credits WHERE id = $1 AND attorney_id = $2 RETURNING id`,
        [id, req.user.uid]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found or not yours" });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // CLE compliance summary (California — 25 hrs/3yrs, 4 ethics, 1 competence, 1 bias/elimination, 1 technology)
  app.get("/api/staff/cle-credits/summary", requireBearer, requireFirmUser, async (req, res) => {
    try {
      // Look at last 3 years by default (CA compliance period)
      const from = new Date();
      from.setFullYear(from.getFullYear() - 3);
      const r = await db.query(
        `SELECT COALESCE(SUM(hours), 0)::float AS total_hours,
                COALESCE(SUM(ethics_hours), 0)::float AS ethics_hours,
                COALESCE(SUM(competence_hours), 0)::float AS competence_hours,
                COALESCE(SUM(bias_hours), 0)::float AS bias_hours,
                COALESCE(SUM(tech_hours), 0)::float AS tech_hours,
                COUNT(*)::int AS credit_count
         FROM cle_credits WHERE attorney_id = $1 AND credit_date >= $2`,
        [req.user.uid, from.toISOString().substring(0, 10)]
      );
      const s = r.rows[0];
      // California requirements
      const REQ = { total: 25, ethics: 4, competence: 1, bias: 1, tech: 1 };
      res.json({
        ok: true,
        summary: {
          period_start: from.toISOString().substring(0, 10),
          period_end: new Date().toISOString().substring(0, 10),
          total_hours: s.total_hours,
          ethics_hours: s.ethics_hours,
          competence_hours: s.competence_hours,
          bias_hours: s.bias_hours,
          tech_hours: s.tech_hours,
          credit_count: s.credit_count,
          requirements: REQ,
          on_track: {
            total: s.total_hours >= REQ.total,
            ethics: s.ethics_hours >= REQ.ethics,
            competence: s.competence_hours >= REQ.competence,
            bias: s.bias_hours >= REQ.bias,
            tech: s.tech_hours >= REQ.tech,
          },
        },
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Court Prep Checklists ────────────────────────────────

  app.get("/api/staff/tasks/:id/prep-items", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `SELECT * FROM court_prep_items WHERE task_id = $1 ORDER BY position, id`,
        [id]
      );
      res.json({ ok: true, items: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/staff/tasks/:id/prep-items", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const items = Array.isArray(req.body?.items) ? req.body.items : [req.body?.item_text].filter(Boolean);
      if (!items.length) return res.status(400).json({ ok: false, error: "item_text or items[] required" });
      // Get current max position
      const maxR = await db.query(
        `SELECT COALESCE(MAX(position), 0)::int AS m FROM court_prep_items WHERE task_id = $1`,
        [id]
      );
      let pos = maxR.rows[0].m;
      const inserted = [];
      for (const text of items) {
        pos += 1;
        const r = await db.query(
          `INSERT INTO court_prep_items (task_id, item_text, position) VALUES ($1, $2, $3) RETURNING *`,
          [id, String(text).substring(0, 300), pos]
        );
        inserted.push(r.rows[0]);
      }
      res.json({ ok: true, items: inserted });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/prep-items/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const fields = [];
      const params = [];
      let i = 1;
      if (typeof req.body?.completed === "boolean") {
        fields.push(`completed = $${i++}`);
        params.push(req.body.completed);
      }
      if (typeof req.body?.item_text === "string") {
        fields.push(`item_text = $${i++}`);
        params.push(String(req.body.item_text).substring(0, 300));
      }
      if (typeof req.body?.position === "number") {
        fields.push(`position = $${i++}`);
        params.push(req.body.position);
      }
      if (!fields.length) return res.status(400).json({ ok: false, error: "nothing to update" });
      fields.push("updated_at = NOW()");
      params.push(id);
      const r = await db.query(
        `UPDATE court_prep_items SET ${fields.join(", ")} WHERE id = $${i++} RETURNING *`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, item: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.delete("/api/staff/prep-items/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      await db.query(`DELETE FROM court_prep_items WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CONSULTANT ASSIGNMENTS (admin + manager control which
  //  consultants have access to which clients)
  // ═══════════════════════════════════════════════════════

  // List all consultant users (for admin to pick from)
  app.get("/api/staff/admin/consultants", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, username, full_name, email, disabled
         FROM admin_users
         WHERE role = 'consultant' AND COALESCE(disabled, false) = false
         ORDER BY full_name ASC`
      );
      res.json({ ok: true, consultants: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // List consultants assigned to a specific client
  app.get("/api/staff/clients/:key/consultants", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      // Return both active and historical (removed) assignments — history matters
      const r = await db.query(
        `SELECT cc.*,
                cu.full_name AS consultant_name, cu.username AS consultant_username, cu.email AS consultant_email,
                bu.full_name AS assigned_by_name,
                ru.full_name AS removed_by_name
         FROM client_consultants cc
         LEFT JOIN admin_users cu ON cu.id = cc.consultant_id
         LEFT JOIN admin_users bu ON bu.id = cc.assigned_by
         LEFT JOIN admin_users ru ON ru.id = cc.removed_by
         WHERE cc.client_key = $1
         ORDER BY (cc.removed_at IS NULL) DESC, cc.assigned_at DESC`,
        [req.params.key]
      );
      res.json({ ok: true, assignments: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Assign a consultant to a client
  app.post("/api/staff/clients/:key/consultants", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const clientKey = req.params.key;
      const consultantId = parseInt(req.body?.consultant_id, 10);
      if (!Number.isFinite(consultantId)) {
        return res.status(400).json({ ok: false, error: "consultant_id required" });
      }
      // Verify the user is actually a consultant
      const uR = await db.query(
        `SELECT id, role, full_name FROM admin_users WHERE id = $1 AND COALESCE(disabled, false) = false`,
        [consultantId]
      );
      if (!uR.rows[0]) return res.status(404).json({ ok: false, error: "consultant not found or disabled" });
      if (uR.rows[0].role !== "consultant") {
        return res.status(400).json({ ok: false, error: "That user is not a consultant" });
      }
      // Prevent duplicate active assignment
      const existing = await db.query(
        `SELECT id FROM client_consultants
         WHERE client_key = $1 AND consultant_id = $2 AND removed_at IS NULL LIMIT 1`,
        [clientKey, consultantId]
      );
      if (existing.rows.length) {
        return res.status(400).json({ ok: false, error: `${uR.rows[0].full_name} is already assigned to this client.` });
      }
      const r = await db.query(
        `INSERT INTO client_consultants (client_key, consultant_id, role_description, assigned_by, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          clientKey, consultantId,
          req.body?.role_description ? String(req.body.role_description).substring(0, 300) : null,
          req.user.uid,
          req.body?.notes ? String(req.body.notes).substring(0, 1000) : null,
        ]
      );
      // Notify the consultant they now have access
      try {
        const push = require("./push-notifications");
        await push.sendToUser("consultant", consultantId, {
          title: "📁 New client assigned",
          body: `You've been assigned access to a client case.`,
          data: { type: "consultant_client_assigned", client_key: clientKey },
        });
      } catch (e) { console.warn("[consultant assign push]:", e.message); }
      res.json({ ok: true, assignment: r.rows[0] });
    } catch (err) {
      console.error("[assign consultant]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Remove a consultant's access to a client (soft delete — firm keeps history)
  app.delete("/api/staff/clients/:key/consultants/:id", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const assignmentId = parseInt(req.params.id, 10);
      if (!Number.isFinite(assignmentId)) return res.status(400).json({ ok: false, error: "bad id" });
      const reason = req.body?.reason ? String(req.body.reason).substring(0, 500) : null;
      const r = await db.query(
        `UPDATE client_consultants
         SET removed_at = NOW(), removed_by = $1, removal_reason = $2
         WHERE id = $3 AND client_key = $4 AND removed_at IS NULL
         RETURNING *`,
        [req.user.uid, reason, assignmentId, req.params.key]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "assignment not found or already removed" });
      res.json({ ok: true, assignment: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Helper: get set of client_keys this consultant is currently assigned to
  async function getConsultantClientKeys(consultantId) {
    const r = await db.query(
      `SELECT DISTINCT client_key FROM client_consultants
       WHERE consultant_id = $1 AND removed_at IS NULL AND client_key IS NOT NULL`,
      [consultantId]
    );
    return new Set(r.rows.map(x => x.client_key));
  }

  // ═══════════════════════════════════════════════════════
  //  E-SIGNATURE (public route + admin-side send)
  // ═══════════════════════════════════════════════════════

  // Send a generated document for e-signature (attorney/admin/manager/consultant)
  app.post("/api/staff/documents/:id/send-for-signature", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const docId = parseInt(req.params.id, 10);
      if (!Number.isFinite(docId)) return res.status(400).json({ ok: false, error: "bad id" });
      const { recipient_email, recipient_phone, recipient_name, send_via, expires_days } = req.body || {};
      if (!recipient_email && !recipient_phone) {
        return res.status(400).json({ ok: false, error: "recipient_email or recipient_phone required" });
      }
      const via = String(send_via || (recipient_email ? "email" : "sms")).toLowerCase();
      // Load document + verify caller can access
      const dR = await db.query(`SELECT * FROM generated_documents WHERE id = $1`, [docId]);
      const doc = dR.rows[0];
      if (!doc) return res.status(404).json({ ok: false, error: "document not found" });
      const canAccess = doc.generated_by === req.user.uid
        || req.user.r === "admin" || req.user.r === "manager"
        || (doc.client_key && await canUserAccessClient(req.user, doc.client_key));
      if (!canAccess) return res.status(403).json({ ok: false, error: "no access" });
      // Generate unique signing token
      const crypto = require("crypto");
      const token = crypto.randomBytes(24).toString("base64url");
      const expires = new Date(Date.now() + (parseInt(expires_days, 10) || 14) * 24 * 60 * 60 * 1000);
      const r = await db.query(
        `INSERT INTO document_signatures
           (generated_document_id, sign_token, recipient_email, recipient_phone,
            recipient_name, sent_by, sent_via, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          docId, token,
          recipient_email ? String(recipient_email).trim().substring(0, 200) : null,
          recipient_phone ? String(recipient_phone).trim().substring(0, 40) : null,
          recipient_name ? String(recipient_name).trim().substring(0, 200) : null,
          req.user.uid, via, expires,
        ]
      );
      const signUrl = `${process.env.RENDER_EXTERNAL_URL || 'https://tezlaw-bot.onrender.com'}/sign/${token}`;
      // Send via email or SMS
      let deliveryStatus = "not_sent";
      let deliveryError = null;
      const message = `Tez Law P.C. — please sign the document "${doc.title}". Open this secure link to review + sign: ${signUrl}\n\nThis link expires in ${parseInt(expires_days, 10) || 14} days.`;
      if (via === "sms" && recipient_phone) {
        try {
          const twilio = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilio.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: recipient_phone,
          });
          deliveryStatus = "sms_sent";
        } catch (e) { deliveryError = e.message; deliveryStatus = "sms_failed"; console.warn("[sign sms]:", e.message); }
      }
      if (via === "email" && recipient_email) {
        try {
          const emailMod = require("./email-sender");  // if exists
          if (emailMod && typeof emailMod.sendEmail === "function") {
            await emailMod.sendEmail({
              to: recipient_email,
              subject: `Please sign: ${doc.title}`,
              text: message,
              html: `<p>Hello${recipient_name ? ' ' + recipient_name : ''},</p>
<p>Tez Law P.C. has sent you a document to review and sign:</p>
<p><strong>${doc.title}</strong></p>
<p><a href="${signUrl}" style="display:inline-block;padding:12px 24px;background:#B79C62;color:#0C1C36;text-decoration:none;border-radius:4px;font-weight:bold;">Review + Sign Document</a></p>
<p>Or copy this link: ${signUrl}</p>
<p>This link expires in ${parseInt(expires_days, 10) || 14} days.</p>
<p>Contact Tez Law at 626-678-8677 with any questions.</p>`,
            });
            deliveryStatus = "email_sent";
          } else {
            deliveryError = "Email sender not configured";
          }
        } catch (e) { deliveryError = e.message; deliveryStatus = "email_failed"; console.warn("[sign email]:", e.message); }
      }
      res.json({ ok: true, signature_request: r.rows[0], sign_url: signUrl, delivery_status: deliveryStatus, delivery_error: deliveryError });
    } catch (err) {
      console.error("[send for signature]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Public: fetch document for signing (via token)
  app.get("/api/public/sign/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!token) return res.status(400).json({ ok: false, error: "bad token" });
      const r = await db.query(
        `SELECT s.*, g.title, g.body, g.template_name
         FROM document_signatures s
         LEFT JOIN generated_documents g ON g.id = s.generated_document_id
         WHERE s.sign_token = $1`,
        [token]
      );
      const sig = r.rows[0];
      if (!sig) return res.status(404).json({ ok: false, error: "signature link not found" });
      if (sig.expires_at && new Date(sig.expires_at) < new Date()) {
        return res.status(410).json({ ok: false, error: "signature link expired" });
      }
      res.json({
        ok: true,
        signed: !!sig.signed_at,
        document: {
          title: sig.title,
          body: sig.body,
          template_name: sig.template_name,
        },
        recipient: {
          name: sig.recipient_name,
        },
        signed_at: sig.signed_at,
        signed_by_name: sig.signed_by_name,
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Public: submit signature
  app.post("/api/public/sign/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      const { signed_by_name, signature_data } = req.body || {};
      if (!signed_by_name || !signature_data) {
        return res.status(400).json({ ok: false, error: "signed_by_name and signature_data required" });
      }
      const r = await db.query(
        `UPDATE document_signatures
         SET signed_at = NOW(), signed_by_name = $1, signature_data = $2,
             signer_ip = $3, signer_user_agent = $4
         WHERE sign_token = $5 AND signed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
         RETURNING *`,
        [
          String(signed_by_name).substring(0, 200),
          String(signature_data).substring(0, 500000),
          req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
          req.headers['user-agent']?.substring(0, 500) || null,
          token,
        ]
      );
      if (!r.rows[0]) return res.status(410).json({ ok: false, error: "already signed or expired" });
      // Notify the sender + admins
      try {
        const push = require("./push-notifications");
        await push.sendToUser(null, r.rows[0].sent_by, {
          title: "✅ Document signed",
          body: `${signed_by_name} signed a document you sent.`,
          data: { type: "document_signed", signature_id: r.rows[0].id },
        });
      } catch {}
      res.json({ ok: true, signature: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Get signature status for a document (staff)
  app.get("/api/staff/documents/:id/signatures", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const docId = parseInt(req.params.id, 10);
      if (!Number.isFinite(docId)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `SELECT s.*, u.full_name AS sent_by_name
         FROM document_signatures s
         LEFT JOIN admin_users u ON u.id = s.sent_by
         WHERE s.generated_document_id = $1
         ORDER BY s.sent_at DESC`,
        [docId]
      );
      res.json({ ok: true, signatures: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  PRACTICE INSIGHTS (admin only)
  //  ─────────────────────────────────────────────────────
  //  Aggregates key firm metrics for a date range: revenue,
  //  hours logged (with per-staff breakdown), outstanding invoices,
  //  new + completed cases, upcoming hearings. Also compares to
  //  the previous period of the same length.
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/admin/insights", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const period = String(req.query.period || "month");
      const now = new Date();
      let from; let to = new Date(now);
      let prevFrom; let prevTo;

      if (period === "week") {
        from = new Date(now); from.setDate(from.getDate() - 7);
        prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 7);
        prevTo = new Date(from);
      } else if (period === "month") {
        from = new Date(now); from.setDate(from.getDate() - 30);
        prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 30);
        prevTo = new Date(from);
      } else if (period === "quarter") {
        from = new Date(now); from.setDate(from.getDate() - 90);
        prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 90);
        prevTo = new Date(from);
      } else if (period === "year") {
        from = new Date(now); from.setDate(from.getDate() - 365);
        prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 365);
        prevTo = new Date(from);
      } else {
        // custom: use from + to query params
        from = req.query.from ? new Date(String(req.query.from)) : new Date(now.getTime() - 30 * 86400e3);
        to = req.query.to ? new Date(String(req.query.to)) : new Date(now);
        const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400e3));
        prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - days);
        prevTo = new Date(from);
      }

      const fromStr = from.toISOString();
      const toStr = to.toISOString();
      const prevFromStr = prevFrom.toISOString();
      const prevToStr = prevTo.toISOString();

      const [
        revenueR, prevRevenueR, outstandingR,
        hoursR, prevHoursR, hoursByStaffR,
        newTasksR, completedTasksR, newClientsR,
        hearingsR,
      ] = await Promise.all([
        // Revenue: paid invoices in period
        db.query(
          `SELECT COALESCE(SUM(amount_cents), 0)::int AS total, COUNT(*)::int AS count
           FROM client_invoices WHERE status = 'paid' AND paid_at >= $1 AND paid_at <= $2`,
          [fromStr, toStr]
        ),
        db.query(
          `SELECT COALESCE(SUM(amount_cents), 0)::int AS total, COUNT(*)::int AS count
           FROM client_invoices WHERE status = 'paid' AND paid_at >= $1 AND paid_at <= $2`,
          [prevFromStr, prevToStr]
        ),
        // Outstanding (all-time, not just period)
        db.query(
          `SELECT COALESCE(SUM(amount_cents), 0)::int AS total, COUNT(*)::int AS count
           FROM client_invoices WHERE status = 'sent'`
        ),
        // Hours logged in period
        db.query(
          `SELECT COALESCE(SUM(minutes), 0)::int AS total_minutes,
                  COALESCE(SUM(CASE WHEN billable THEN minutes ELSE 0 END), 0)::int AS billable_minutes,
                  COALESCE(SUM(ROUND((minutes::numeric / 60) * COALESCE(hourly_rate_cents, 0))), 0)::int AS billable_cents,
                  COUNT(*)::int AS count
           FROM time_entries WHERE created_at >= $1 AND created_at <= $2`,
          [fromStr, toStr]
        ),
        db.query(
          `SELECT COALESCE(SUM(minutes), 0)::int AS total_minutes
           FROM time_entries WHERE created_at >= $1 AND created_at <= $2`,
          [prevFromStr, prevToStr]
        ),
        // Hours by staff (this period)
        db.query(
          `SELECT a.id, a.full_name, a.role,
                  COALESCE(SUM(t.minutes), 0)::int AS minutes,
                  COALESCE(SUM(CASE WHEN t.billable THEN t.minutes ELSE 0 END), 0)::int AS billable_minutes,
                  COALESCE(SUM(ROUND((t.minutes::numeric / 60) * COALESCE(t.hourly_rate_cents, 0))), 0)::int AS billable_cents
           FROM admin_users a
           LEFT JOIN time_entries t ON t.staff_id = a.id AND t.created_at >= $1 AND t.created_at <= $2
           WHERE a.disabled = false AND a.role != 'consultant'
           GROUP BY a.id, a.full_name, a.role
           HAVING COALESCE(SUM(t.minutes), 0) > 0
           ORDER BY minutes DESC`,
          [fromStr, toStr]
        ),
        // Tasks created in period
        db.query(
          `SELECT COUNT(*)::int AS n FROM tasks WHERE created_at >= $1 AND created_at <= $2`,
          [fromStr, toStr]
        ),
        // Tasks completed in period
        db.query(
          `SELECT COUNT(*)::int AS n FROM tasks WHERE completed = true AND updated_at >= $1 AND updated_at <= $2`,
          [fromStr, toStr]
        ),
        // New distinct clients in period (first appearance)
        db.query(
          `SELECT COUNT(DISTINCT client_key)::int AS n FROM tasks
           WHERE client_key IS NOT NULL AND created_at >= $1 AND created_at <= $2
             AND client_key NOT IN (SELECT DISTINCT client_key FROM tasks WHERE client_key IS NOT NULL AND created_at < $1)`,
          [fromStr, toStr]
        ),
        // Upcoming hearings (next 7 days from now, not the period)
        db.query(
          `SELECT COUNT(*)::int AS n FROM tasks
           WHERE due_date IS NOT NULL AND due_date >= CURRENT_DATE AND due_date <= CURRENT_DATE + 7
             AND (completed = false OR completed IS NULL)
             AND (LOWER(description) LIKE '%hearing%' OR LOWER(description) LIKE '%court%'
                  OR LOWER(description) LIKE '%interview%' OR LOWER(description) LIKE '%deposition%')`
        ),
      ]);

      const pct = (curr, prev) => {
        if (prev === 0) return curr > 0 ? 100 : null;
        return Math.round(((curr - prev) / prev) * 100);
      };

      const revenue = revenueR.rows[0].total;
      const prevRevenue = prevRevenueR.rows[0].total;
      const hours = hoursR.rows[0].total_minutes;
      const prevHours = prevHoursR.rows[0].total_minutes;

      res.json({
        ok: true,
        period,
        from: fromStr,
        to: toStr,
        prev_from: prevFromStr,
        prev_to: prevToStr,
        revenue: {
          cents: revenue,
          display: `$${(revenue / 100).toFixed(2)}`,
          count: revenueR.rows[0].count,
          prev_cents: prevRevenue,
          change_pct: pct(revenue, prevRevenue),
        },
        outstanding: {
          cents: outstandingR.rows[0].total,
          display: `$${(outstandingR.rows[0].total / 100).toFixed(2)}`,
          count: outstandingR.rows[0].count,
        },
        hours: {
          total_minutes: hours,
          total_hours: Math.round((hours / 60) * 10) / 10,
          billable_minutes: hoursR.rows[0].billable_minutes,
          billable_hours: Math.round((hoursR.rows[0].billable_minutes / 60) * 10) / 10,
          billable_value_cents: hoursR.rows[0].billable_cents,
          billable_value_display: `$${(hoursR.rows[0].billable_cents / 100).toFixed(2)}`,
          entry_count: hoursR.rows[0].count,
          prev_minutes: prevHours,
          change_pct: pct(hours, prevHours),
        },
        hours_by_staff: hoursByStaffR.rows.map((r) => ({
          id: r.id,
          name: r.full_name,
          role: r.role,
          minutes: r.minutes,
          hours: Math.round((r.minutes / 60) * 10) / 10,
          billable_hours: Math.round((r.billable_minutes / 60) * 10) / 10,
          billable_value_cents: r.billable_cents,
          billable_value_display: `$${(r.billable_cents / 100).toFixed(2)}`,
        })),
        cases: {
          new: newTasksR.rows[0].n,
          completed: completedTasksR.rows[0].n,
          new_clients: newClientsR.rows[0].n,
        },
        upcoming_hearings_next_7d: hearingsR.rows[0].n,
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  DATA EXPORT (admin only)
  //  ─────────────────────────────────────────────────────
  //  CSV exports of key firm data for tax season, quarterly
  //  reporting, or backup. Returns Content-Type: text/csv.
  // ═══════════════════════════════════════════════════════

  function csvEscape(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  app.get("/api/staff/admin/export/clients.csv", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT DISTINCT client_key, client_name, client_phone, client_email, matter_type,
                MIN(created_at) AS first_seen, MAX(created_at) AS last_activity,
                COUNT(*) AS task_count
         FROM tasks WHERE client_key IS NOT NULL
         GROUP BY client_key, client_name, client_phone, client_email, matter_type
         ORDER BY client_name`
      );
      const lines = ["client_key,client_name,client_phone,client_email,matter_type,first_seen,last_activity,task_count"];
      for (const row of r.rows) {
        lines.push([row.client_key, row.client_name, row.client_phone, row.client_email, row.matter_type,
          row.first_seen ? new Date(row.first_seen).toISOString() : "",
          row.last_activity ? new Date(row.last_activity).toISOString() : "",
          row.task_count].map(csvEscape).join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="tezlaw-clients-${new Date().toISOString().substring(0, 10)}.csv"`);
      res.send(lines.join("\r\n"));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/staff/admin/export/invoices.csv", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT i.id, i.client_key,
                (SELECT client_name FROM tasks t WHERE t.client_key = i.client_key LIMIT 1) AS client_name,
                i.description, i.amount_cents, i.status, i.due_date, i.paid_at, i.paid_method,
                i.client_claim_paid_at, i.created_at
         FROM client_invoices i ORDER BY i.created_at DESC`
      );
      const lines = ["id,client_key,client_name,description,amount_usd,status,due_date,paid_at,paid_method,client_claim_paid_at,created_at"];
      for (const row of r.rows) {
        lines.push([
          row.id, row.client_key, row.client_name, row.description,
          ((row.amount_cents || 0) / 100).toFixed(2),
          row.status, row.due_date || "",
          row.paid_at ? new Date(row.paid_at).toISOString() : "",
          row.paid_method || "",
          row.client_claim_paid_at ? new Date(row.client_claim_paid_at).toISOString() : "",
          new Date(row.created_at).toISOString(),
        ].map(csvEscape).join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="tezlaw-invoices-${new Date().toISOString().substring(0, 10)}.csv"`);
      res.send(lines.join("\r\n"));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/staff/admin/export/time-entries.csv", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;
      const params = [];
      let where = "1=1";
      if (from) { params.push(from); where += ` AND t.entry_date >= $${params.length}::date`; }
      if (to) { params.push(to); where += ` AND t.entry_date <= $${params.length}::date`; }
      const r = await db.query(
        `SELECT t.id, t.entry_date, a.full_name AS staff, t.client_key,
                (SELECT client_name FROM tasks tk WHERE tk.client_key = t.client_key LIMIT 1) AS client_name,
                t.description, t.minutes, t.hourly_rate_cents, t.billable, t.invoice_id
         FROM time_entries t LEFT JOIN admin_users a ON a.id = t.staff_id
         WHERE ${where}
         ORDER BY t.entry_date DESC, t.id DESC`,
        params
      );
      const lines = ["id,entry_date,staff,client_key,client_name,description,minutes,hours,rate_usd,billable,amount_usd,invoice_id"];
      for (const row of r.rows) {
        const hours = ((row.minutes || 0) / 60).toFixed(2);
        const rateUsd = ((row.hourly_rate_cents || 0) / 100).toFixed(2);
        const amountUsd = (((row.minutes || 0) / 60) * ((row.hourly_rate_cents || 0) / 100)).toFixed(2);
        lines.push([
          row.id, row.entry_date, row.staff, row.client_key, row.client_name,
          row.description, row.minutes, hours, rateUsd,
          row.billable ? "yes" : "no", amountUsd, row.invoice_id || "",
        ].map(csvEscape).join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="tezlaw-time-${new Date().toISOString().substring(0, 10)}.csv"`);
      res.send(lines.join("\r\n"));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  IOLTA / CLIENT TRUST ACCOUNTING (Cal. Rules of Prof. Conduct 1.15)
  //  ─────────────────────────────────────────────────────
  //  CA attorneys must maintain client trust accounts. Every deposit
  //  and withdrawal is logged per client. Withdrawals cannot exceed
  //  current balance. Every entry snapshots the running balance for
  //  audit-friendly ledger presentation.
  //
  //  Categories: retainer, settlement, costs_advance, earned_fees,
  //  refund, other. Deposits are always positive; withdrawals are
  //  logged as positive amounts with txn_type='withdrawal'.
  //
  //  Firm-wide summary + reconciliation available to admin.
  // ═══════════════════════════════════════════════════════

  // Get a client's current trust balance + full transaction ledger
  app.get("/api/staff/clients/:key/trust", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const r = await db.query(
        `SELECT t.*, a.full_name AS staff_name
         FROM trust_transactions t
         LEFT JOIN admin_users a ON a.id = t.staff_id
         WHERE t.client_key = $1
         ORDER BY t.transaction_date DESC, t.id DESC`,
        [req.params.key]
      );
      const currentBalance = r.rows.length ? r.rows[0].running_balance_cents : 0;
      const totalDeposits = r.rows.filter(x => x.txn_type === "deposit").reduce((s, x) => s + x.amount_cents, 0);
      const totalWithdrawals = r.rows.filter(x => x.txn_type === "withdrawal").reduce((s, x) => s + x.amount_cents, 0);
      res.json({
        ok: true,
        current_balance_cents: currentBalance,
        current_balance_display: `$${(currentBalance / 100).toFixed(2)}`,
        total_deposits_cents: totalDeposits,
        total_deposits_display: `$${(totalDeposits / 100).toFixed(2)}`,
        total_withdrawals_cents: totalWithdrawals,
        total_withdrawals_display: `$${(totalWithdrawals / 100).toFixed(2)}`,
        transaction_count: r.rows.length,
        transactions: r.rows,
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Record a trust transaction (deposit or withdrawal)
  app.post("/api/staff/clients/:key/trust", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "no access" });
      const { txn_type, category, amount_cents, description, memo, reference_number, transaction_date } = req.body || {};
      if (!txn_type || !["deposit", "withdrawal"].includes(txn_type)) {
        return res.status(400).json({ ok: false, error: "txn_type must be 'deposit' or 'withdrawal'" });
      }
      const amt = parseInt(amount_cents, 10);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ ok: false, error: "amount_cents must be a positive integer" });
      }
      if (!description || !String(description).trim()) {
        return res.status(400).json({ ok: false, error: "description required" });
      }
      // Compute new running balance
      const balR = await db.query(
        `SELECT COALESCE(running_balance_cents, 0)::int AS bal
         FROM trust_transactions WHERE client_key = $1 ORDER BY id DESC LIMIT 1`,
        [req.params.key]
      );
      const currentBal = balR.rows[0]?.bal || 0;
      const newBal = txn_type === "deposit" ? currentBal + amt : currentBal - amt;
      if (newBal < 0) {
        return res.status(400).json({
          ok: false,
          error: `Insufficient trust funds. Current balance: $${(currentBal / 100).toFixed(2)}. Cannot withdraw $${(amt / 100).toFixed(2)}.`,
          current_balance_cents: currentBal,
        });
      }
      const r = await db.query(
        `INSERT INTO trust_transactions
           (client_key, staff_id, txn_type, category, amount_cents,
            description, memo, reference_number, transaction_date,
            running_balance_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE), $10)
         RETURNING *`,
        [req.params.key, req.user.uid, txn_type,
         category || null,
         amt,
         String(description).substring(0, 500),
         memo ? String(memo).substring(0, 1000) : null,
         reference_number ? String(reference_number).substring(0, 100) : null,
         transaction_date || null,
         newBal]
      );
      res.json({
        ok: true,
        transaction: r.rows[0],
        new_balance_cents: newBal,
        new_balance_display: `$${(newBal / 100).toFixed(2)}`,
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Reverse a transaction (creates a mirror-image counter-entry, doesn't delete)
  app.post("/api/staff/trust/:id/reverse", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const isAdmin = req.user.role === "admin";
      if (!isAdmin) return res.status(403).json({ ok: false, error: "admin only" });
      const origR = await db.query(`SELECT * FROM trust_transactions WHERE id = $1`, [id]);
      if (!origR.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      const orig = origR.rows[0];
      if (orig.reversed_by_txn_id) return res.status(400).json({ ok: false, error: "already reversed" });
      const reverseType = orig.txn_type === "deposit" ? "withdrawal" : "deposit";
      const balR = await db.query(
        `SELECT COALESCE(running_balance_cents, 0)::int AS bal
         FROM trust_transactions WHERE client_key = $1 ORDER BY id DESC LIMIT 1`,
        [orig.client_key]
      );
      const currentBal = balR.rows[0]?.bal || 0;
      const newBal = reverseType === "deposit" ? currentBal + orig.amount_cents : currentBal - orig.amount_cents;
      if (newBal < 0) {
        return res.status(400).json({
          ok: false,
          error: `Cannot reverse — would leave a negative balance ($${(newBal / 100).toFixed(2)}).`,
        });
      }
      const r = await db.query(
        `INSERT INTO trust_transactions
           (client_key, staff_id, txn_type, category, amount_cents,
            description, memo, transaction_date, running_balance_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)
         RETURNING *`,
        [orig.client_key, req.user.uid, reverseType, "reversal",
         orig.amount_cents,
         `REVERSAL of txn #${id}: ${orig.description}`,
         `Reversed by ${req.user.n || "admin"} — reason: ${req.body?.reason || "not specified"}`,
         newBal]
      );
      // Link original as reversed
      await db.query(`UPDATE trust_transactions SET reversed_by_txn_id = $1 WHERE id = $2`, [r.rows[0].id, id]);
      res.json({ ok: true, reversal: r.rows[0], new_balance_cents: newBal });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Admin: firm-wide trust account summary
  app.get("/api/staff/admin/trust/summary", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      // Get latest running_balance for each client_key
      const r = await db.query(`
        WITH latest AS (
          SELECT DISTINCT ON (client_key)
            client_key, running_balance_cents, transaction_date, id
          FROM trust_transactions
          ORDER BY client_key, id DESC
        )
        SELECT
          l.client_key,
          l.running_balance_cents,
          l.transaction_date AS last_activity,
          (SELECT client_name FROM tasks t WHERE t.client_key = l.client_key LIMIT 1) AS client_name,
          (SELECT COUNT(*)::int FROM trust_transactions WHERE client_key = l.client_key) AS txn_count
        FROM latest l
        WHERE l.running_balance_cents > 0
        ORDER BY l.running_balance_cents DESC
      `);
      const firmTotal = r.rows.reduce((s, row) => s + (row.running_balance_cents || 0), 0);
      res.json({
        ok: true,
        firm_total_cents: firmTotal,
        firm_total_display: `$${(firmTotal / 100).toFixed(2)}`,
        client_count: r.rows.length,
        clients: r.rows.map(row => ({
          ...row,
          balance_display: `$${((row.running_balance_cents || 0) / 100).toFixed(2)}`,
        })),
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  MATTER TEMPLATES / CASE WORKFLOWS
  //  ─────────────────────────────────────────────────────
  //  Predefined task lists for common case types. When JJ or
  //  staff starts a new matter, they pick a template and it
  //  creates all standard tasks with proper due dates and
  //  assignments (via matter_defaults or specified per-task).
  // ═══════════════════════════════════════════════════════

  // List all active templates (optionally filtered by matter_type)
  app.get("/api/staff/matter-templates", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const params = [];
      let where = "active = true";
      if (req.query.matter_type) {
        params.push(String(req.query.matter_type));
        where += ` AND matter_type = $${params.length}`;
      }
      const r = await db.query(
        `SELECT id, matter_type, name, description,
                (SELECT COUNT(*)::int FROM matter_template_tasks WHERE template_id = matter_templates.id) AS task_count
         FROM matter_templates WHERE ${where}
         ORDER BY matter_type, name`,
        params
      );
      res.json({ ok: true, templates: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Get a template's full task list
  app.get("/api/staff/matter-templates/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const t = await db.query(`SELECT * FROM matter_templates WHERE id = $1`, [id]);
      if (!t.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
      const tasks = await db.query(
        `SELECT * FROM matter_template_tasks WHERE template_id = $1 ORDER BY sort_order ASC, id ASC`,
        [id]
      );
      res.json({ ok: true, template: t.rows[0], tasks: tasks.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Instantiate a template for a client — creates all tasks
  app.post("/api/staff/matter-templates/:id/instantiate", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const {
        client_key, client_name, client_phone, client_email,
        matter_type, start_date, a_number
      } = req.body || {};
      if (!client_name) return res.status(400).json({ ok: false, error: "client_name required" });

      const t = await db.query(`SELECT * FROM matter_templates WHERE id = $1`, [id]);
      if (!t.rows[0]) return res.status(404).json({ ok: false, error: "template not found" });
      const template = t.rows[0];
      const effectiveMatter = matter_type || template.matter_type;
      const start = start_date ? new Date(start_date) : new Date();
      const effectiveKey = client_key || `client-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

      // Load matter default assignee (if any)
      const defR = await db.query(`SELECT assigned_to FROM matter_defaults WHERE matter_type = $1`, [effectiveMatter]);
      const defaultAssignee = defR.rows[0]?.assigned_to || null;

      // Load all template tasks
      const taskR = await db.query(
        `SELECT * FROM matter_template_tasks WHERE template_id = $1 ORDER BY sort_order ASC, id ASC`,
        [id]
      );

      const createdTasks = [];
      for (const tt of taskR.rows) {
        let dueDate = null;
        if (tt.due_offset_days != null) {
          const d = new Date(start);
          d.setDate(d.getDate() + tt.due_offset_days);
          dueDate = d.toISOString().substring(0, 10);
        }
        const assignee = tt.assigned_to || (tt.assign_via_matter_default ? defaultAssignee : null);
        const r = await db.query(
          `INSERT INTO tasks
             (description, priority, matter_type, client_key, client_name, client_phone, client_email,
              a_number, due_date, assigned_to, created_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open')
           RETURNING id, description, due_date, assigned_to`,
          [tt.description, tt.priority || 'normal', effectiveMatter,
           effectiveKey, client_name, client_phone || null, client_email || null,
           a_number || null, dueDate, assignee, req.user.uid]
        );
        createdTasks.push(r.rows[0]);
      }

      res.json({
        ok: true,
        client_key: effectiveKey,
        client_name,
        matter_type: effectiveMatter,
        template_used: template.name,
        tasks_created: createdTasks.length,
        tasks: createdTasks,
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  BRANCHES (offices)
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/branches", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(`SELECT id, code, name, address, phone, active FROM branches WHERE active = true ORDER BY name`);
      res.json({ ok: true, branches: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.patch("/api/staff/admin/users/:id/branch", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const branchId = req.body?.branch_id ? parseInt(req.body.branch_id, 10) : null;
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(
        `UPDATE admin_users SET branch_id = $1 WHERE id = $2 RETURNING id, username, full_name, branch_id`,
        [branchId, id]
      );
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "user not found" });
      res.json({ ok: true, user: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  REPORTS — RECEIVABLES
  //  ─────────────────────────────────────────────────────
  //  Aggregated outstanding invoices, groupable by:
  //  - branch: creator's branch (via admin_users.branch_id)
  //  - attorney: creator's user id (if role attorney or admin)
  //  - consultant: the active consultant assigned to that client
  //  - matter_type: derived from the matching task
  //
  //  Filterable by date range (invoice created_at). Available to
  //  admin + manager.
  // ═══════════════════════════════════════════════════════

  async function fetchReceivablesData(fromStr, toStr) {
    // Base query: all outstanding invoices in the date range with joined metadata
    const params = [];
    let where = "i.status = 'sent'";
    if (fromStr) { params.push(fromStr); where += ` AND i.created_at >= $${params.length}::date`; }
    if (toStr)   { params.push(toStr);   where += ` AND i.created_at <= $${params.length}::date + INTERVAL '1 day'`; }
    const r = await db.query(
      `SELECT
         i.id, i.client_key, i.description, i.amount_cents, i.due_date, i.created_at,
         i.created_by,
         a.full_name       AS creator_name,
         a.role            AS creator_role,
         a.branch_id       AS branch_id,
         b.name            AS branch_name,
         (SELECT client_name FROM tasks t WHERE t.client_key = i.client_key LIMIT 1)  AS client_name,
         (SELECT matter_type FROM tasks t WHERE t.client_key = i.client_key LIMIT 1) AS matter_type,
         (SELECT cc.consultant_id FROM client_consultants cc
          WHERE cc.client_key = i.client_key AND cc.removed_at IS NULL
          ORDER BY cc.assigned_at DESC LIMIT 1)                                       AS consultant_id,
         (SELECT ac.full_name FROM client_consultants cc
          LEFT JOIN admin_users ac ON ac.id = cc.consultant_id
          WHERE cc.client_key = i.client_key AND cc.removed_at IS NULL
          ORDER BY cc.assigned_at DESC LIMIT 1)                                       AS consultant_name
       FROM client_invoices i
       LEFT JOIN admin_users a  ON a.id = i.created_by
       LEFT JOIN branches    b  ON b.id = a.branch_id
       WHERE ${where}
       ORDER BY i.created_at DESC`,
      params
    );
    return r.rows;
  }

  function groupReceivables(rows, groupBy) {
    const groups = new Map();
    for (const row of rows) {
      let key, label;
      if (groupBy === 'branch') {
        key = row.branch_id ? `b${row.branch_id}` : 'unassigned';
        label = row.branch_name || 'No branch assigned';
      } else if (groupBy === 'attorney') {
        key = row.created_by ? `a${row.created_by}` : 'unassigned';
        label = row.creator_name || 'Unknown';
      } else if (groupBy === 'consultant') {
        key = row.consultant_id ? `c${row.consultant_id}` : 'none';
        label = row.consultant_name || 'No consultant';
      } else if (groupBy === 'matter_type') {
        key = row.matter_type || 'other';
        label = row.matter_type || 'Uncategorized';
      } else {
        key = 'total';
        label = 'All Invoices';
      }
      if (!groups.has(key)) {
        groups.set(key, { key, label, total_cents: 0, count: 0, invoices: [] });
      }
      const g = groups.get(key);
      g.total_cents += row.amount_cents || 0;
      g.count += 1;
      g.invoices.push({
        id: row.id,
        client_key: row.client_key,
        client_name: row.client_name,
        description: row.description,
        amount_cents: row.amount_cents,
        amount_display: `$${((row.amount_cents || 0) / 100).toFixed(2)}`,
        matter_type: row.matter_type,
        created_at: row.created_at,
        due_date: row.due_date,
        days_outstanding: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400e3),
        creator: row.creator_name,
        branch: row.branch_name,
        consultant: row.consultant_name,
      });
    }
    return Array.from(groups.values())
      .map(g => ({ ...g, total_display: `$${(g.total_cents / 100).toFixed(2)}` }))
      .sort((a, b) => b.total_cents - a.total_cents);
  }

  app.get("/api/staff/reports/receivables", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const groupBy = String(req.query.group_by || 'branch');
      const fromStr = req.query.from ? String(req.query.from) : null;
      const toStr = req.query.to ? String(req.query.to) : null;
      const rows = await fetchReceivablesData(fromStr, toStr);
      const groups = groupReceivables(rows, groupBy);
      const grandTotal = rows.reduce((s, r) => s + (r.amount_cents || 0), 0);
      res.json({
        ok: true,
        report: 'receivables',
        group_by: groupBy,
        from: fromStr,
        to: toStr,
        grand_total_cents: grandTotal,
        grand_total_display: `$${(grandTotal / 100).toFixed(2)}`,
        invoice_count: rows.length,
        groups,
      });
    } catch (err) {
      console.error("[receivables]:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  function csvEscapeReport(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  app.get("/api/staff/reports/receivables.csv", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const fromStr = req.query.from ? String(req.query.from) : null;
      const toStr = req.query.to ? String(req.query.to) : null;
      const rows = await fetchReceivablesData(fromStr, toStr);
      const lines = ["invoice_id,client_key,client_name,description,amount_usd,matter_type,branch,attorney,consultant,created_at,due_date,days_outstanding"];
      for (const r of rows) {
        const days = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400e3);
        lines.push([
          r.id, r.client_key, r.client_name || '', r.description,
          ((r.amount_cents || 0) / 100).toFixed(2),
          r.matter_type || '', r.branch_name || '',
          r.creator_name || '', r.consultant_name || '',
          new Date(r.created_at).toISOString().substring(0, 10),
          r.due_date || '', days,
        ].map(csvEscapeReport).join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="tezlaw-receivables-${new Date().toISOString().substring(0, 10)}.csv"`);
      res.send(lines.join("\r\n"));
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Printable HTML for PDF export via iOS Print → Save as PDF
  app.get("/api/staff/reports/receivables/print", requireBearer, requireFirmUser, requireManagerOrAdmin, async (req, res) => {
    try {
      const groupBy = String(req.query.group_by || 'branch');
      const fromStr = req.query.from ? String(req.query.from) : null;
      const toStr = req.query.to ? String(req.query.to) : null;
      const rows = await fetchReceivablesData(fromStr, toStr);
      const groups = groupReceivables(rows, groupBy);
      const grandTotal = rows.reduce((s, r) => s + (r.amount_cents || 0), 0);
      const groupLabel = { branch: 'Branch', attorney: 'Attorney', consultant: 'Consultant', matter_type: 'Matter Type' }[groupBy] || groupBy;
      const escape = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Tez Law — Receivables Report</title>
<style>
  @page { size: letter; margin: 0.5in; }
  body { font: 12px -apple-system, BlinkMacSystemFont, sans-serif; color: #0C1C36; margin: 0; padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #0C1C36; }
  .subtitle { color: #555; font-size: 12px; margin-bottom: 24px; }
  .summary { background: #0C1C36; color: white; padding: 16px; border-radius: 6px; margin-bottom: 24px; }
  .summary .total { font-size: 28px; font-weight: 700; color: #B79C62; }
  .summary .label { text-transform: uppercase; font-size: 11px; letter-spacing: 2px; color: #B79C62; }
  .summary .sub { font-size: 12px; opacity: 0.8; margin-top: 4px; }
  h2 { font-size: 15px; margin: 20px 0 6px; padding: 6px 10px; background: #f0f0f0; border-left: 4px solid #B79C62; }
  h2 .amt { float: right; color: #0C1C36; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eee; font-size: 11px; }
  th { background: #fafafa; font-weight: 700; color: #555; }
  .amt-col { text-align: right; font-variant-numeric: tabular-nums; }
  .days-hot { color: #c00; font-weight: 700; }
  .footer { margin-top: 40px; padding-top: 10px; border-top: 1px solid #ddd; color: #888; font-size: 10px; text-align: center; }
  @media print { body { padding: 0; } .print-btn { display: none; } }
  .print-btn { position: fixed; top: 20px; right: 20px; background: #B79C62; color: #0C1C36; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: 700; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
</style></head><body>
<a href="javascript:window.print()" class="print-btn">Print / Save as PDF</a>
<h1>Tez Law P.C. — Receivables Report</h1>
<div class="subtitle">Grouped by ${groupLabel}${fromStr ? ` · From ${fromStr}` : ''}${toStr ? ` · To ${toStr}` : ''} · Generated ${new Date().toLocaleString()}</div>
<div class="summary">
  <div class="label">Total Outstanding</div>
  <div class="total">$${(grandTotal / 100).toFixed(2)}</div>
  <div class="sub">${rows.length} unpaid invoice${rows.length === 1 ? '' : 's'} · Across ${groups.length} ${groupLabel.toLowerCase()}${groups.length === 1 ? '' : 's'}</div>
</div>
${groups.map(g => `
  <h2>${escape(g.label)} <span class="amt">${g.total_display} (${g.count})</span></h2>
  <table>
    <thead><tr><th>Client</th><th>Description</th><th>Matter</th><th>Days</th><th class="amt-col">Amount</th></tr></thead>
    <tbody>
      ${g.invoices.map(inv => `
        <tr>
          <td>${escape(inv.client_name || '—')}</td>
          <td>${escape(inv.description)}</td>
          <td>${escape(inv.matter_type || '')}</td>
          <td class="${inv.days_outstanding > 60 ? 'days-hot' : ''}">${inv.days_outstanding}d</td>
          <td class="amt-col">${inv.amount_display}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
`).join('')}
<div class="footer">Tez Law P.C. · 626-678-8677 · jj@tezlawfirm.com · This report is confidential and privileged.</div>
</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  DROPBOX MAPPINGS SWEEP (admin only)
  //  ─────────────────────────────────────────────────────
  //  For fixing wrong Dropbox-to-client links. Lists current mappings,
  //  suggests folder matches for unlinked clients, allows manual link.
  // ═══════════════════════════════════════════════════════

  app.get("/api/staff/admin/dropbox/mappings", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      // Get all clients from tasks (canonical, excluding aliases)
      const clientsR = await db.query(
        `SELECT DISTINCT t.client_key, t.client_name, t.client_phone, t.client_email,
                t.matter_type, t.a_number,
                MAX(t.created_at) AS last_activity
         FROM tasks t
         WHERE t.client_key IS NOT NULL
           AND t.client_key NOT IN (SELECT alias_key FROM client_aliases)
         GROUP BY t.client_key, t.client_name, t.client_phone, t.client_email, t.matter_type, t.a_number
         ORDER BY t.client_name`
      );

      // Get all current dropbox mappings
      const mappingsR = await db.query(
        `SELECT client_key, dropbox_path, a_number AS mapping_a_number, client_name AS mapping_name, resolved_at, resolved_by
         FROM client_dropbox_mapping`
      ).catch(() => ({ rows: [] }));  // Handle if table doesn't exist yet

      const mappingByKey = new Map();
      for (const m of mappingsR.rows) {
        mappingByKey.set(m.client_key, m);
      }

      // Also find orphan mappings (dropbox mapping exists but no matching client)
      const clientKeys = new Set(clientsR.rows.map(c => c.client_key));
      const orphanMappings = mappingsR.rows.filter(m => !clientKeys.has(m.client_key));

      const enriched = clientsR.rows.map(c => {
        const mapping = mappingByKey.get(c.client_key);
        // Also try to find mapping by a_number match
        const byANumber = c.a_number && !mapping
          ? mappingsR.rows.find(m => m.mapping_a_number && m.mapping_a_number.replace(/\D/g, '') === (c.a_number || '').replace(/\D/g, ''))
          : null;
        const effectivePath = mapping?.dropbox_path || byANumber?.dropbox_path || null;

        // Detect wrong-match: client name has NO word overlap with folder path
        // Also check A-number mismatch if both are present
        let isWrongMatch = false;
        let wrongReason = null;
        if (effectivePath && c.client_name) {
          // Extract words from client name (length >= 3 to skip initials/short particles)
          const nameWords = String(c.client_name)
            .toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .split(/[^a-z]+/)
            .filter(w => w.length >= 3);
          const pathLower = effectivePath.toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          // If NONE of the client name words appear in the path, it's likely wrong
          const anyOverlap = nameWords.some(w => pathLower.includes(w));
          if (nameWords.length > 0 && !anyOverlap) {
            isWrongMatch = true;
            wrongReason = 'name-vs-folder mismatch';
          }
          // Check A-number mismatch if both present in mapping
          if (mapping?.mapping_a_number && c.a_number) {
            const mA = mapping.mapping_a_number.replace(/\D/g, '');
            const cA = c.a_number.replace(/\D/g, '');
            if (mA && cA && mA !== cA) {
              isWrongMatch = true;
              wrongReason = wrongReason ? wrongReason + ' + A# mismatch' : 'A# mismatch';
            }
          }
        }

        return {
          ...c,
          dropbox_path: effectivePath,
          mapping_resolved_at: mapping?.resolved_at || null,
          mapping_resolved_by: mapping?.resolved_by || null,
          matched_by_anumber: !!byANumber,
          status: isWrongMatch ? 'wrong_match' : (mapping ? 'linked' : (byANumber ? 'linked_by_anumber' : 'unlinked')),
          wrong_reason: wrongReason,
        };
      });

      const stats = {
        total_clients: enriched.length,
        linked: enriched.filter(c => c.status === 'linked').length,
        linked_by_anumber: enriched.filter(c => c.status === 'linked_by_anumber').length,
        unlinked: enriched.filter(c => c.status === 'unlinked').length,
        wrong_match: enriched.filter(c => c.status === 'wrong_match').length,
        orphan_mappings: orphanMappings.length,
      };

      res.json({
        ok: true,
        stats,
        clients: enriched,
        orphan_mappings: orphanMappings,
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/staff/admin/dropbox/suggest", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const clientKey = String(req.query.client_key || "").trim();
      if (!clientKey) return res.status(400).json({ ok: false, error: "client_key required" });
      const c = await db.query(
        `SELECT client_name, a_number FROM tasks WHERE client_key = $1 LIMIT 1`,
        [clientKey]
      );
      if (!c.rows[0]) return res.status(404).json({ ok: false, error: "client not found" });
      const dbx = require("./dropbox-integration");
      const suggestions = await dbx.suggestClientFolders({
        clientName: c.rows[0].client_name,
        aNumber: c.rows[0].a_number,
        minScore: 15,
        limit: 15,
      });
      res.json({
        ok: true,
        client: c.rows[0],
        suggestions: suggestions || [],
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/staff/admin/dropbox/mappings", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const { client_key, dropbox_path } = req.body || {};
      if (!client_key || !dropbox_path) {
        return res.status(400).json({ ok: false, error: "client_key and dropbox_path required" });
      }
      const c = await db.query(
        `SELECT client_name, a_number FROM tasks WHERE client_key = $1 LIMIT 1`,
        [client_key]
      );
      const dbx = require("./dropbox-integration");
      await dbx.setClientFolderMapping({
        clientKey: client_key,
        aNumber: c.rows[0]?.a_number || null,
        clientName: c.rows[0]?.client_name || null,
        dropboxPath: dropbox_path,
      });
      res.json({ ok: true, client_key, dropbox_path });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.delete("/api/staff/admin/dropbox/mappings/:key", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const dbx = require("./dropbox-integration");
      await dbx.clearClientFolderMapping(req.params.key);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Bulk-clear all mappings the sweep flagged as wrong-match
  app.post("/api/staff/admin/dropbox/clear-wrong-matches", requireBearer, requireFirmUser, requireAdmin, async (req, res) => {
    try {
      const { client_keys } = req.body || {};
      if (!Array.isArray(client_keys) || !client_keys.length) {
        return res.status(400).json({ ok: false, error: "client_keys array required" });
      }
      const dbx = require("./dropbox-integration");
      let cleared = 0;
      const errors = [];
      for (const key of client_keys) {
        try {
          await dbx.clearClientFolderMapping(String(key));
          cleared++;
        } catch (e) {
          errors.push({ key, error: e.message });
        }
      }
      res.json({ ok: true, cleared, errors });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CONSULTANT PORTAL API
  //  (naturally scoped to their own submissions + assigned clients)
  // ═══════════════════════════════════════════════════════

  // ── Consultant client access (assigned clients only) ────

  // List clients this consultant is currently assigned to
  app.get("/api/consultant/clients", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT cc.id AS assignment_id, cc.client_key, cc.role_description, cc.assigned_at,
                cc.notes AS assignment_notes,
                MAX(t.client_name) AS client_name,
                MAX(t.client_phone) AS client_phone,
                MAX(t.client_email) AS client_email,
                MAX(t.matter_type) AS matter_type,
                COUNT(DISTINCT t.id) FILTER (WHERE t.completed = false OR t.completed IS NULL) AS open_task_count
         FROM client_consultants cc
         LEFT JOIN tasks t ON t.client_key = cc.client_key
         WHERE cc.consultant_id = $1 AND cc.removed_at IS NULL
         GROUP BY cc.id, cc.client_key, cc.role_description, cc.assigned_at, cc.notes
         ORDER BY MAX(t.updated_at) DESC NULLS LAST`,
        [req.user.uid]
      );
      res.json({ ok: true, clients: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Get client detail (consultant view — same shape as staff, but access-checked)
  app.get("/api/consultant/clients/:key", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const keys = await getConsultantClientKeys(req.user.uid);
      if (!keys.has(req.params.key) && req.user.r !== "admin") {
        return res.status(403).json({ ok: false, error: "You're not assigned to this client" });
      }
      // Get client info via first task
      const cR = await db.query(
        `SELECT DISTINCT ON (client_key)
           client_key, client_name, client_phone, client_email, matter_type
         FROM tasks WHERE client_key = $1 LIMIT 1`,
        [req.params.key]
      );
      if (!cR.rows[0]) return res.status(404).json({ ok: false, error: "client not found" });
      // Get assignment info
      const aR = await db.query(
        `SELECT role_description, assigned_at, notes
         FROM client_consultants
         WHERE client_key = $1 AND consultant_id = $2 AND removed_at IS NULL LIMIT 1`,
        [req.params.key, req.user.uid]
      );
      res.json({
        ok: true,
        client: cR.rows[0],
        assignment: aR.rows[0] || null,
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // List tasks for a client (consultant view — filtered to their scope)
  app.get("/api/consultant/clients/:key/tasks", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const keys = await getConsultantClientKeys(req.user.uid);
      if (!keys.has(req.params.key) && req.user.r !== "admin") {
        return res.status(403).json({ ok: false, error: "not assigned" });
      }
      const r = await db.query(
        `SELECT id, description, matter_type, due_date, completed, priority, created_at,
                assigned_to, submitted_by_user_id, status
         FROM tasks WHERE client_key = $1
         ORDER BY (completed IS NULL OR completed = false) DESC,
                  due_date ASC NULLS LAST, created_at DESC
         LIMIT 100`,
        [req.params.key]
      );
      res.json({ ok: true, tasks: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Consultant messaging ────────────────────────────
  // List messages for a client (consultant view)
  app.get("/api/consultant/clients/:key/messages", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const keys = await getConsultantClientKeys(req.user.uid);
      if (!keys.has(req.params.key) && req.user.r !== "admin") {
        return res.status(403).json({ ok: false, error: "not assigned" });
      }
      // Reuse the client_messages table
      const r = await db.query(
        `SELECT * FROM client_messages WHERE client_key = $1 ORDER BY created_at ASC LIMIT 500`,
        [req.params.key]
      ).catch(() => ({ rows: [] }));
      res.json({ ok: true, messages: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Send a message to a client (consultant → client)
  app.post("/api/consultant/clients/:key/messages", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const keys = await getConsultantClientKeys(req.user.uid);
      if (!keys.has(req.params.key) && req.user.r !== "admin") {
        return res.status(403).json({ ok: false, error: "not assigned" });
      }
      const body = String(req.body?.body || "").trim();
      if (!body) return res.status(400).json({ ok: false, error: "body required" });
      const r = await db.query(
        `INSERT INTO client_messages (client_key, sender_kind, sender_name, sender_id, sender_role, body)
         VALUES ($1, 'firm', $2, $3, 'consultant', $4) RETURNING *`,
        [req.params.key, req.user.n || 'Consultant', req.user.uid, body.substring(0, 4000)]
      );
      // Push to any linked client accounts
      try {
        const push = require("./push-notifications");
        const acctR = await db.query(`SELECT id FROM client_accounts WHERE client_key = $1`, [req.params.key]);
        for (const row of acctR.rows) {
          await push.sendToUser("client", row.id, {
            title: "💬 New message from Tez Law",
            body: body.substring(0, 100),
            data: { type: "message" },
          });
        }
      } catch {}
      res.json({ ok: true, message: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Consultant document generation ──────────────────
  // Consultants can generate documents (retainers etc) on behalf of the firm.
  // The document is marked as consultant-drafted; attorney reviews via
  // firm-side "generated documents" list.

  app.get("/api/consultant/document-templates", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      // Consultants get access to retainer + engagement templates by default
      const r = await db.query(
        `SELECT id, slug, name, category, description, variables
         FROM document_templates
         WHERE category IN ('retainer', 'engagement', 'letter')
         ORDER BY category, name`
      );
      res.json({ ok: true, templates: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/consultant/clients/:key/documents/generate", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const keys = await getConsultantClientKeys(req.user.uid);
      if (!keys.has(req.params.key) && req.user.r !== "admin") {
        return res.status(403).json({ ok: false, error: "not assigned" });
      }
      const { template_slug, variables, title } = req.body || {};
      if (!template_slug || !variables) return res.status(400).json({ ok: false, error: "template_slug + variables required" });
      const tR = await db.query(`SELECT * FROM document_templates WHERE slug = $1`, [String(template_slug)]);
      const tpl = tR.rows[0];
      if (!tpl) return res.status(404).json({ ok: false, error: "template not found" });
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const allVars = { ...variables, today_date: today };
      let body = tpl.body;
      for (const [key, value] of Object.entries(allVars)) {
        const safe = String(value ?? '').replace(/\$/g, '$$$$');
        body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), safe);
      }
      const finalTitle = String(title || `${tpl.name} — ${variables.client_name || 'Untitled'}`).substring(0, 300);
      const saved = await db.query(
        `INSERT INTO generated_documents
           (client_key, template_slug, template_name, title, body, variables, generated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [req.params.key, template_slug, tpl.name, finalTitle, body, JSON.stringify(allVars), req.user.uid]
      );
      // Notify admins that consultant drafted a document
      try {
        const push = require("./push-notifications");
        await push.sendToAdmins({
          title: "📝 Consultant drafted a document",
          body: `${req.user.n || 'A consultant'} drafted "${finalTitle}"`,
          data: { type: "consultant_doc_drafted", document_id: saved.rows[0].id },
        });
      } catch {}
      res.json({ ok: true, document: saved.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // List generated documents for consultant's assigned clients
  app.get("/api/consultant/documents/generated", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const keys = await getConsultantClientKeys(req.user.uid);
      if (!keys.size) return res.json({ ok: true, documents: [] });
      const r = await db.query(
        `SELECT g.id, g.client_key, g.template_name, g.title, g.generated_by, g.created_at,
                a.full_name AS generated_by_name
         FROM generated_documents g
         LEFT JOIN admin_users a ON a.id = g.generated_by
         WHERE (g.generated_by = $1 OR g.client_key = ANY($2::text[]))
         ORDER BY g.created_at DESC LIMIT 100`,
        [req.user.uid, Array.from(keys)]
      );
      res.json({ ok: true, documents: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/consultant/documents/generated/:id", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const r = await db.query(`SELECT * FROM generated_documents WHERE id = $1`, [id]);
      const doc = r.rows[0];
      if (!doc) return res.status(404).json({ ok: false, error: "not found" });
      const keys = await getConsultantClientKeys(req.user.uid);
      const canAccess = doc.generated_by === req.user.uid
        || (doc.client_key && keys.has(doc.client_key));
      if (!canAccess) return res.status(403).json({ ok: false, error: "no access" });
      res.json({ ok: true, document: doc });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/consultant/documents/:id/send-for-signature", requireBearer, requireConsultantRole, async (req, res) => {
    // Delegate to the staff endpoint by wrapping req (same access check applies)
    try {
      const docId = parseInt(req.params.id, 10);
      if (!Number.isFinite(docId)) return res.status(400).json({ ok: false, error: "bad id" });
      const dR = await db.query(`SELECT * FROM generated_documents WHERE id = $1`, [docId]);
      const doc = dR.rows[0];
      if (!doc) return res.status(404).json({ ok: false, error: "document not found" });
      const keys = await getConsultantClientKeys(req.user.uid);
      const canAccess = doc.generated_by === req.user.uid
        || (doc.client_key && keys.has(doc.client_key));
      if (!canAccess) return res.status(403).json({ ok: false, error: "no access" });

      const { recipient_email, recipient_phone, recipient_name, send_via, expires_days } = req.body || {};
      if (!recipient_email && !recipient_phone) {
        return res.status(400).json({ ok: false, error: "recipient_email or recipient_phone required" });
      }
      const via = String(send_via || (recipient_email ? "email" : "sms")).toLowerCase();
      const crypto = require("crypto");
      const token = crypto.randomBytes(24).toString("base64url");
      const expires = new Date(Date.now() + (parseInt(expires_days, 10) || 14) * 24 * 60 * 60 * 1000);
      const r = await db.query(
        `INSERT INTO document_signatures
           (generated_document_id, sign_token, recipient_email, recipient_phone, recipient_name, sent_by, sent_via, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          docId, token,
          recipient_email ? String(recipient_email).trim().substring(0, 200) : null,
          recipient_phone ? String(recipient_phone).trim().substring(0, 40) : null,
          recipient_name ? String(recipient_name).trim().substring(0, 200) : null,
          req.user.uid, via, expires,
        ]
      );
      const signUrl = `${process.env.RENDER_EXTERNAL_URL || 'https://tezlaw-bot.onrender.com'}/sign/${token}`;
      const message = `Tez Law P.C. — please sign the document "${doc.title}". Open this secure link to review + sign: ${signUrl}\n\nThis link expires in ${parseInt(expires_days, 10) || 14} days.`;
      let deliveryStatus = "not_sent", deliveryError = null;
      if (via === "sms" && recipient_phone) {
        try {
          const twilio = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilio.messages.create({ body: message, from: process.env.TWILIO_PHONE_NUMBER, to: recipient_phone });
          deliveryStatus = "sms_sent";
        } catch (e) { deliveryError = e.message; deliveryStatus = "sms_failed"; }
      }
      if (via === "email" && recipient_email) {
        try {
          const emailMod = require("./email-sender");
          if (emailMod?.sendEmail) {
            await emailMod.sendEmail({
              to: recipient_email,
              subject: `Please sign: ${doc.title}`,
              text: message,
              html: `<p>Hello${recipient_name ? ' ' + recipient_name : ''},</p><p>Tez Law P.C. has sent you "${doc.title}" for signature.</p><p><a href="${signUrl}" style="display:inline-block;padding:12px 24px;background:#B79C62;color:#0C1C36;text-decoration:none;border-radius:4px;font-weight:bold;">Review + Sign</a></p><p>Link: ${signUrl}</p>`,
            });
            deliveryStatus = "email_sent";
          } else { deliveryError = "Email sender not configured"; }
        } catch (e) { deliveryError = e.message; deliveryStatus = "email_failed"; }
      }
      res.json({ ok: true, signature_request: r.rows[0], sign_url: signUrl, delivery_status: deliveryStatus, delivery_error: deliveryError });
    } catch (err) {
      console.error("[consultant send for sig]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Consultant self-termination cleanup ────────────
  // When a consultant is disabled via admin, mark all their assignments as removed.
  // (Called from the admin user disable endpoint via a wrapper below.)
  async function cleanupConsultantAssignments(consultantId, actorUserId, reason) {
    await db.query(
      `UPDATE client_consultants
       SET removed_at = NOW(), removed_by = $1, removal_reason = $2
       WHERE consultant_id = $3 AND removed_at IS NULL`,
      [actorUserId, reason || "Consultant disabled", consultantId]
    );
  }
  // Attach helper to `app` so the disable-user endpoint can call it
  app.locals.cleanupConsultantAssignments = cleanupConsultantAssignments;

  // ── Existing consultant endpoints below ────────────

  app.get("/api/consultant/dashboard", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const userId = req.user.uid;
      const [openTasks, allStats] = await Promise.all([
        tasks.listTasks({ submitted_by_user_id: userId, limit: 100 }),
        db.query(
          `SELECT status, COUNT(*)::int AS n FROM tasks WHERE submitted_by_user_id = $1 GROUP BY status`,
          [userId]
        ).then(r => r.rows),
      ]);
      const stats = { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
      for (const row of allStats) { stats[row.status] = row.n; stats.total += row.n; }
      res.json({ ok: true, stats, tasks: openTasks });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/consultant/tasks", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const userId = req.user.uid;
      const data = req.body || {};
      const matterType = data.matter_type || "admin";
      // Route consultant-submitted work orders to the right firm member so it
      // lands in that person's task queue after admin approval.
      const autoAssignee = await getDefaultAssignee(matterType);
      const cleaned = {
        title: String(data.title || "").trim(),
        description: data.description ? String(data.description).substring(0, 8000) : null,
        matter_type: matterType,
        priority: ["urgent", "high", "normal", "low"].includes(data.priority) ? data.priority : "normal",
        due_date: data.due_date && /^\d{4}-\d{2}-\d{2}$/.test(data.due_date) ? data.due_date : null,
        client_name: data.client_name ? String(data.client_name).substring(0, 200) : null,
        assigned_to: autoAssignee,           // proposed assignee — takes effect after admin approves
        status: "pending_approval",          // needs admin approval before it enters the firm's task queue
        submitted_by_user_id: userId,
        submitter_visible: true,
        created_by: userId,
        actor_name: req.user.n || req.user.u,
        actor_role: req.user.r,
      };
      if (!cleaned.title) return res.status(400).json({ ok: false, error: "Title required" });
      if (cleaned.client_name) {
        cleaned.client_key = cleaned.client_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      }
      const task = await tasks.createTask(cleaned);
      // Notify all admins that a consultant work order needs approval
      push.sendToAdmins({
        title: "⏳ Work order needs approval",
        body: `${req.user.n || "A consultant"} submitted: ${task.title}`,
        data: { screen: "pending-approvals", taskId: task.id },
      }).catch(() => {});
      res.json({ ok: true, task });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/consultant/tasks/:id", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const milestones = require("./task-milestones");
      const task = await tasks.getTask(id);
      if (!task || task.submitted_by_user_id !== req.user.uid) {
        return res.status(404).json({ ok: false, error: "Not found" });
      }
      const [activity, mList, mProgress] = await Promise.all([
        tasks.listActivity(id, { filterVisibleOnly: true }),
        milestones.listMilestones(id),
        milestones.getProgress(id),
      ]);
      res.json({ ok: true, task, milestones: mList, progress: mProgress, activity });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ─── Consultant Ask Zara (limited scope) ───────────────────
  // Consultants get AI legal help but with limited scope — they
  // only see their own submissions + assigned clients. Uses a
  // separate system prompt that says "you're speaking with a
  // referral consultant, not a licensed attorney."
  app.post("/api/consultant/chat", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message) return res.status(400).json({ ok: false, error: "message required" });
      let zaraChat;
      try { zaraChat = require("./zara-app-chat"); } catch { zaraChat = null; }
      if (!zaraChat || typeof zaraChat.chat !== "function") {
        return res.status(501).json({ ok: false, error: "Chat not available" });
      }
      // Custom system prompt for consultants — limited scope, less firm-data-specific
      const consultantPrompt = `You are Zara, Tez Law P.C.'s AI legal assistant. You are speaking with a REFERRAL CONSULTANT — not a firm attorney. The consultant submits leads and work orders to Tez Law and manages client relationships they've brought in.

Do NOT:
- Give advice that requires practicing law (that's what Tez Law's attorneys do)
- Reveal firm-wide financial data, other consultants' submissions, or clients not assigned to this consultant
- Speculate on case outcomes — for those questions, redirect to the assigned attorney

Do help with:
- Explaining USCIS forms and processes so the consultant can help their clients gather documents
- Answering general legal-process questions (e.g., "what's the typical H-1B timeline?")
- Helping draft messages to their clients or to Tez Law staff
- Interpreting notices or receipts the consultant received
- Guidance on when to escalate matters to the assigned attorney

If asked something outside your scope, redirect politely: "That's something for the assigned attorney — I recommend messaging Tez Law directly through the app."

Format: clear paragraphs, plain language. No excessive markdown.

Tez Law contact: 626-678-8677 · jj@tezlawfirm.com`;

      const answer = await zaraChat.chat({
        systemPrompt: consultantPrompt,
        message: String(message),
        history: history || [],
        // No db/user — consultant chat doesn't get firm-data tools
      });
      res.json({ ok: true, reply: { answer } });
    } catch (err) {
      console.error("[api chat consultant]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/consultant/tasks/:id/comment", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const task = await tasks.getTask(id);
      if (!task || task.submitted_by_user_id !== req.user.uid) {
        return res.status(404).json({ ok: false, error: "Not found" });
      }
      const note = String(req.body?.note || "").trim().substring(0, 2000);
      if (!note) return res.status(400).json({ ok: false, error: "Note required" });
      await tasks.addTaskComment(id, {
        actor_id: req.user.uid, actor_name: req.user.n || req.user.u,
        actor_role: req.user.r, note, visible_to_submitter: true,
      });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CLIENT PORTAL API (SMS OTP)
  //  (naturally scoped to their own client_key)
  // ═══════════════════════════════════════════════════════

  app.get("/api/client/overview", requireBearer, requireClient, async (req, res) => {
    try {
      const clientKey = req.user.ck;
      if (!clientKey) {
        return res.json({
          ok: true,
          linked_to_case: false,
          message: "Your account isn't linked to a case yet. Please contact Tez Law at 626-678-8677.",
        });
      }
      const [hearings, deadlines, unread] = await Promise.all([
        db.query(
          `SELECT id, hearing_date, hearing_type, court_name, judge_name
           FROM client_hearing_notices
           WHERE client_key = $1 AND dismissed_at IS NULL AND hearing_date >= CURRENT_DATE - INTERVAL '30 days'
           ORDER BY hearing_date ASC LIMIT 20`,
          [clientKey]
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT id, description, due_date, priority
           FROM deadlines
           WHERE client_key = $1 AND status = 'pending'
           ORDER BY due_date ASC LIMIT 20`,
          [clientKey]
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT COUNT(*)::int AS n FROM client_messages
           WHERE client_key = $1 AND sender_kind = 'firm' AND read_at IS NULL`,
          [clientKey]
        ).then(r => r.rows[0]?.n || 0).catch(() => 0),
      ]);
      const nextHearing = hearings.find(h => new Date(h.hearing_date) >= new Date());
      res.json({
        ok: true,
        linked_to_case: true,
        client_name: req.user.n,
        next_hearing: nextHearing,
        upcoming_hearings: hearings,
        deadlines,
        unread_messages: unread,
      });
    } catch (err) {
      console.error("[api client overview]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/client/messages", requireBearer, requireClient, async (req, res) => {
    try {
      const clientKey = req.user.ck;
      if (!clientKey) return res.json({ ok: true, messages: [] });
      const r = await db.query(
        `SELECT * FROM client_messages WHERE client_key = $1 ORDER BY created_at ASC LIMIT 200`,
        [clientKey]
      );
      await db.query(
        `UPDATE client_messages SET read_at = NOW()
         WHERE client_key = $1 AND sender_kind = 'firm' AND read_at IS NULL`,
        [clientKey]
      );
      res.json({ ok: true, messages: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/client/messages", requireBearer, requireClient, async (req, res) => {
    try {
      const clientKey = req.user.ck;
      if (!clientKey) return res.status(400).json({ ok: false, error: "Account not linked to a case" });
      const body = String(req.body?.body || "").trim().substring(0, 4000);
      if (!body) return res.status(400).json({ ok: false, error: "Message body required" });
      const r = await db.query(
        `INSERT INTO client_messages (client_key, sender_kind, sender_name, sender_id, body)
         VALUES ($1, 'client', $2, $3, $4) RETURNING *`,
        [clientKey, req.user.n, parseInt(String(req.user.uid).replace(/\D/g, ""), 10) || null, body]
      );
      // Push notify all admins about new client message
      push.sendToAdmins({
        title: `💬 New message from ${req.user.n || "client"}`,
        body: body.substring(0, 100),
        data: { screen: "client-message", clientKey },
      }).catch(() => {});
      try {
        if (process.env.TELEGRAM_BOT_TOKEN && (process.env.HEARING_NOTES_TELEGRAM_GROUP_ID || process.env.TELEGRAM_GROUP_ID)) {
          const axios = require("axios");
          await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: process.env.HEARING_NOTES_TELEGRAM_GROUP_ID || process.env.TELEGRAM_GROUP_ID,
              text: `💬 *New client message* from ${req.user.n || "client"}\n\n${body.substring(0, 400)}`,
              parse_mode: "Markdown",
            }
          ).catch(() => {});
        }
      } catch {}
      res.json({ ok: true, message: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/client/chat", requireBearer, requireClient, async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message) return res.status(400).json({ ok: false, error: "message required" });
      let zaraChat;
      try { zaraChat = require("./zara-app-chat"); } catch { zaraChat = null; }
      if (!zaraChat || typeof zaraChat.chat !== "function") {
        return res.status(501).json({ ok: false, error: "Chat not available" });
      }

      // Look up this client's real case context so Zara can personalize responses.
      // Never fails the chat if lookup errors — falls back to basic prompt.
      let caseContext = null;
      try {
        // req.user.uid is the client_accounts.id; fetch phone + client_key
        const acctR = await db.query(
          `SELECT full_name, email, phone, client_key, language
           FROM client_accounts WHERE id = $1 LIMIT 1`,
          [req.user.uid]
        );
        const acct = acctR.rows[0];
        if (acct && acct.client_key) {
          const cp = require("./client-profiles");
          const profile = await cp.getClientByKey(acct.client_key);
          if (profile) {
            const now = Date.now();
            const upcoming = (profile.hearings || [])
              .filter(h => h.hearing_date && new Date(h.hearing_date).getTime() >= now)
              .sort((a, b) => new Date(a.hearing_date) - new Date(b.hearing_date))
              .slice(0, 2)
              .map(h => `${new Date(h.hearing_date).toDateString()}${h.type_label ? ` (${h.type_label})` : ""}${h.court_name ? ` at ${h.court_name}` : ""}`);
            const openDeadlines = (profile.deadlines || [])
              .filter(d => !d.completed_at)
              .slice(0, 3)
              .map(d => `${d.description}${d.due_date ? ` (due ${new Date(d.due_date).toDateString()})` : ""}`);
            caseContext = {
              name: profile.client_name || acct.full_name,
              a_number: profile.a_number || null,
              case_types: Array.from(profile.case_types || []),
              upcoming_hearings: upcoming,
              open_deadlines: openDeadlines,
              language: acct.language || req.user.lang || "en",
            };
          } else {
            caseContext = { name: acct.full_name, language: acct.language || "en" };
          }
        } else if (acct) {
          caseContext = { name: acct.full_name, language: acct.language || "en" };
        }
      } catch (e) {
        console.warn("[client chat context lookup]:", e.message);
      }

      const answer = await zaraChat.chat({
        systemPrompt: zaraChat.CLIENT_SYSTEM_PROMPT(
          req.user.n,
          req.user.lang || "en",
          caseContext
        ),
        message: String(message),
        history: history || [],
      });
      res.json({ ok: true, reply: { answer } });
    } catch (err) {
      console.error("[api chat client]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log("[app-api] registered — mobile app endpoints live at /api/* (with role-based visibility + admin client linking)");
}

module.exports = { registerAppApi };
