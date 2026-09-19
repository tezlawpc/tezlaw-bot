// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-schema.js — DATABASE SCHEMA (PostgreSQL)
//  ─────────────────────────────────────────────────────────
//  Idempotent. Safe to call on every boot.
//
//  Storage follows the house convention from client-documents.js:
//  file bytes live in PostgreSQL BYTEA so they back up with the
//  rest of the database and there is no second system to secure.
//  Per-file cap is 50MB here rather than 25MB because audit PBC
//  items (full GL downloads, count sheets, scanned minute books)
//  routinely run larger than immigration exhibits.
//
//  ── The AS 1215 compliance design ──
//  AS 1215.16 is unusual among auditing standards in that it is
//  effectively a database specification: after the documentation
//  completion date, documentation MUST NOT be deleted or discarded;
//  information may be ADDED, but each addition must record the date
//  added, the preparer, and the REASON for adding it.
//
//  Honoring that in application code alone is not enough — an
//  application bug, a stray admin query or a future maintainer can
//  all bypass it. So it is enforced at the database level by two
//  triggers:
//
//    trg_ngtf_audit_doc_immutable   blocks DELETE, and blocks UPDATE
//                                   of file bytes / hash / identity
//                                   columns, on any document whose
//                                   engagement is archived or locked
//
//    trg_ngtf_audit_event_append    blocks UPDATE and DELETE on the
//                                   event log outright, always
//
//  Post-archive additions are still permitted — that is what
//  AS 1215.16 allows — but they must carry addition_reason,
//  addition_by and addition_at, and the trigger rejects the insert
//  without them. Retention runs seven years from the report release
//  date under AS 1215.14, with an indefinite legal-hold override.
// ============================================================

const db = require("./db");

const MAX_FILE_BYTES = Number(process.env.AUDIT_MAX_FILE_MB || 50) * 1024 * 1024;

// Advisory-lock key for schema init. Any stable 64-bit constant works;
// this one is arbitrary but must not change once deployed.
const INIT_LOCK_KEY = 738104219;

let _initPromise = null;

/**
 * Create every table, index and trigger. Idempotent AND concurrency-safe.
 *
 * Two layers of protection, because `CREATE TABLE IF NOT EXISTS` is NOT
 * safe to run concurrently in PostgreSQL — two sessions that pass the
 * existence check at the same moment both proceed to create, and the
 * loser fails with a duplicate-key error on pg_type. That is not
 * hypothetical: it happens whenever boot code calls init() twice, and
 * whenever two application instances start against the same database,
 * which is the normal case on a platform that runs more than one dyno.
 *
 *   1. In-process: the in-flight promise is memoized, so concurrent
 *      callers in this process await the same run rather than starting
 *      a second one.
 *   2. Cross-process: a session-level advisory lock serializes
 *      instances. The second instance waits, then finds everything
 *      already present and does nothing.
 */
async function initAuditTables() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const client = await db.connect();
    try {
      await client.query(`SELECT pg_advisory_lock($1)`, [INIT_LOCK_KEY]);
      await createAll();
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [INIT_LOCK_KEY]);
      } catch {
        /* lock is released with the session anyway */
      }
      client.release();
    }
  })().catch((err) => {
    // Let a later attempt retry rather than caching the failure forever.
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

async function createAll() {
  // ── Users ────────────────────────────────────────────────
  // org: 'company' (Nightfood) | 'auditor' (TAAD) | 'committee'
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_users (
      id             SERIAL PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE,
      name           TEXT NOT NULL,
      org            TEXT NOT NULL DEFAULT 'company',
      role           TEXT NOT NULL DEFAULT 'company_contributor',
      firm_name      TEXT,
      title          TEXT,
      password_hash  TEXT,
      phone          TEXT,
      notify_email   BOOLEAN DEFAULT TRUE,
      notify_sms     BOOLEAN DEFAULT FALSE,
      notify_digest  TEXT DEFAULT 'daily',
      notify_instant BOOLEAN DEFAULT TRUE,
      active         BOOLEAN DEFAULT TRUE,
      must_reset     BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      last_login     TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_users_org ON ngtf_audit_users (org, active)`);

  // Session signing secret — self-generating, survives restarts.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_session_settings (
      id      INTEGER PRIMARY KEY DEFAULT 1,
      secret  TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Engagements (one per reporting period) ───────────────
  // status: open → fieldwork → review → report_released → archived → locked
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_engagements (
      id                   SERIAL PRIMARY KEY,
      fiscal_year          INTEGER NOT NULL,
      tier                 TEXT NOT NULL,
      period_label         TEXT NOT NULL,
      period_name          TEXT,
      period_end           DATE,
      quarter              INTEGER,
      fiscal_month         INTEGER,
      status               TEXT NOT NULL DEFAULT 'open',
      filing_form          TEXT,
      filing_due_date      DATE,
      filing_nt_due_date   DATE,
      filing_extended_date DATE,
      filed_on             DATE,
      report_release_date  DATE,
      doc_completion_date  DATE,
      retention_expiry     DATE,
      legal_hold           BOOLEAN DEFAULT FALSE,
      legal_hold_reason    TEXT,
      archived_at          TIMESTAMPTZ,
      locked_at            TIMESTAMPTZ,
      headline             TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (fiscal_year, tier, period_label)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_eng_status ON ngtf_audit_engagements (status, period_end DESC)`);

  // ── Documents ────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_documents (
      id                 SERIAL PRIMARY KEY,
      engagement_id      INTEGER REFERENCES ngtf_audit_engagements(id),
      category_code      TEXT,
      bracket_code       TEXT,
      folder_path        TEXT,
      filename           TEXT NOT NULL,
      original_filename  TEXT,
      mime_type          TEXT,
      size_bytes         BIGINT NOT NULL,
      sha256             TEXT NOT NULL,
      file_data          BYTEA NOT NULL,
      version            INTEGER NOT NULL DEFAULT 1,
      supersedes_id      INTEGER REFERENCES ngtf_audit_documents(id),
      status             TEXT NOT NULL DEFAULT 'active',
      fiscal_year        INTEGER,
      period_label       TEXT,
      period_as_of       DATE,
      tier               TEXT,
      classification     JSONB,
      confidence         INTEGER,
      classify_method    TEXT,
      needs_confirmation BOOLEAN DEFAULT FALSE,
      confirmed_by       INTEGER REFERENCES ngtf_audit_users(id),
      confirmed_at       TIMESTAMPTZ,
      reclassified_from  TEXT,
      brief              TEXT,
      flags              TEXT[],
      is_confidential    BOOLEAN DEFAULT FALSE,
      is_gate            BOOLEAN DEFAULT FALSE,
      uploaded_by        INTEGER REFERENCES ngtf_audit_users(id),
      uploaded_at        TIMESTAMPTZ DEFAULT NOW(),
      -- AS 1215.16 post-archive addition metadata
      post_archive       BOOLEAN DEFAULT FALSE,
      addition_reason    TEXT,
      addition_by        INTEGER REFERENCES ngtf_audit_users(id),
      addition_at        TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_docs_eng ON ngtf_audit_documents (engagement_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_docs_cat ON ngtf_audit_documents (category_code, period_label)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_docs_sha ON ngtf_audit_documents (sha256)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_docs_uploaded ON ngtf_audit_documents (uploaded_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_docs_triage ON ngtf_audit_documents (needs_confirmation) WHERE needs_confirmation = TRUE`);

  // ── Immutable event log (chain of custody) ───────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_events (
      id           BIGSERIAL PRIMARY KEY,
      document_id  INTEGER,
      engagement_id INTEGER,
      item_id      INTEGER,
      event        TEXT NOT NULL,
      actor_id     INTEGER,
      actor_email  TEXT,
      actor_org    TEXT,
      ip           TEXT,
      user_agent   TEXT,
      detail       JSONB,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_events_doc ON ngtf_audit_events (document_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_events_eng ON ngtf_audit_events (engagement_id, created_at DESC)`);

  // ── Checklist instances + items ──────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_checklists (
      id                SERIAL PRIMARY KEY,
      engagement_id     INTEGER REFERENCES ngtf_audit_engagements(id),
      tier              TEXT NOT NULL,
      fiscal_year       INTEGER NOT NULL,
      period_label      TEXT NOT NULL,
      period_name       TEXT,
      period_end        DATE,
      headline          TEXT,
      filing_due_date   DATE,
      target_complete_by DATE,
      generated_at      TIMESTAMPTZ DEFAULT NOW(),
      completed_at      TIMESTAMPTZ,
      UNIQUE (fiscal_year, tier, period_label)
    )
  `);

  // status: open | satisfied | answered_no | answered_yes | waived | na | overdue
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_checklist_items (
      id                 SERIAL PRIMARY KEY,
      checklist_id       INTEGER NOT NULL REFERENCES ngtf_audit_checklists(id) ON DELETE CASCADE,
      engagement_id      INTEGER REFERENCES ngtf_audit_engagements(id),
      kind               TEXT NOT NULL DEFAULT 'document',
      category_code      TEXT,
      bracket_code       TEXT,
      sweep_id           TEXT,
      label              TEXT NOT NULL,
      authority          TEXT[],
      why                TEXT,
      note               TEXT,
      owner_role         TEXT,
      assigned_to        INTEGER REFERENCES ngtf_audit_users(id),
      due_date           DATE,
      is_gate            BOOLEAN DEFAULT FALSE,
      sensitive          BOOLEAN DEFAULT FALSE,
      status             TEXT NOT NULL DEFAULT 'open',
      satisfied_by_doc   INTEGER REFERENCES ngtf_audit_documents(id),
      satisfied_at       TIMESTAMPTZ,
      answer             BOOLEAN,
      answer_note        TEXT,
      answered_by        INTEGER REFERENCES ngtf_audit_users(id),
      answered_at        TIMESTAMPTZ,
      spawned_from_item  INTEGER REFERENCES ngtf_audit_checklist_items(id),
      spawn_codes        TEXT[],
      waiver_reason      TEXT,
      waived_by          INTEGER REFERENCES ngtf_audit_users(id),
      waived_at          TIMESTAMPTZ,
      auditor_accepted   BOOLEAN DEFAULT FALSE,
      auditor_accepted_by INTEGER REFERENCES ngtf_audit_users(id),
      auditor_accepted_at TIMESTAMPTZ,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_items_list ON ngtf_audit_checklist_items (checklist_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_items_due ON ngtf_audit_checklist_items (due_date, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_items_cat ON ngtf_audit_checklist_items (category_code, checklist_id)`);

  // ── Auditor ↔ company threaded comments / PBC follow-ups ─
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_comments (
      id            SERIAL PRIMARY KEY,
      document_id   INTEGER REFERENCES ngtf_audit_documents(id),
      item_id       INTEGER REFERENCES ngtf_audit_checklist_items(id),
      engagement_id INTEGER REFERENCES ngtf_audit_engagements(id),
      parent_id     INTEGER REFERENCES ngtf_audit_comments(id),
      author_id     INTEGER REFERENCES ngtf_audit_users(id),
      body          TEXT NOT NULL,
      kind          TEXT DEFAULT 'comment',
      resolved      BOOLEAN DEFAULT FALSE,
      resolved_by   INTEGER REFERENCES ngtf_audit_users(id),
      resolved_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_comments_doc ON ngtf_audit_comments (document_id, created_at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_comments_open ON ngtf_audit_comments (resolved, engagement_id)`);

  // ── Notification outbox ──────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_notifications (
      id            SERIAL PRIMARY KEY,
      kind          TEXT NOT NULL,
      channel       TEXT NOT NULL DEFAULT 'email',
      recipient_id  INTEGER REFERENCES ngtf_audit_users(id),
      recipient_addr TEXT,
      subject       TEXT,
      body          TEXT,
      document_id   INTEGER REFERENCES ngtf_audit_documents(id),
      item_id       INTEGER REFERENCES ngtf_audit_checklist_items(id),
      engagement_id INTEGER REFERENCES ngtf_audit_engagements(id),
      status        TEXT NOT NULL DEFAULT 'queued',
      error         TEXT,
      scheduled_for TIMESTAMPTZ DEFAULT NOW(),
      sent_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_notif_queue ON ngtf_audit_notifications (status, scheduled_for)`);

  // ── Download log (auditor chain of custody) ──────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_downloads (
      id           BIGSERIAL PRIMARY KEY,
      document_id  INTEGER REFERENCES ngtf_audit_documents(id),
      user_id      INTEGER REFERENCES ngtf_audit_users(id),
      user_email   TEXT,
      org          TEXT,
      ip           TEXT,
      user_agent   TEXT,
      bytes_sent   BIGINT,
      downloaded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_dl_doc ON ngtf_audit_downloads (document_id, downloaded_at DESC)`);

  // ── Key/value settings ───────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_settings (
      key        TEXT PRIMARY KEY,
      value      JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await installImmutabilityTriggers();
  await seedSettings();
}

// ── AS 1215 enforcement at the database level ───────────────
async function installImmutabilityTriggers() {
  // Documents: no DELETE, and no mutation of bytes/identity, once
  // the parent engagement is archived or locked. Also blocks
  // deletion of any document under legal hold regardless of status.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_doc_immutable()
    RETURNS TRIGGER AS $$
    DECLARE
      eng_id     INTEGER;
      eng_status TEXT;
      eng_hold   BOOLEAN;
      locked     BOOLEAN;
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        SELECT status, legal_hold INTO eng_status, eng_hold
          FROM ngtf_audit_engagements WHERE id = OLD.engagement_id;
        IF COALESCE(eng_status,'') IN ('archived','locked','report_released') OR COALESCE(eng_hold,FALSE) THEN
          RAISE EXCEPTION
            'AS 1215.16: audit documentation may not be deleted after the documentation completion date (engagement status=%, legal_hold=%). Add superseding information instead.',
            eng_status, eng_hold;
        END IF;
        RETURN OLD;
      END IF;

      -- Look the engagement up from OLD first, falling back to NEW.
      -- Reading NEW alone let an UPDATE that ALSO set engagement_id to
      -- NULL slip past: the lookup found no row, eng_status came back
      -- NULL, and "NULL IN (...)" is NULL rather than TRUE, so the guard
      -- was skipped and the bytes could be rewritten and the row then
      -- re-attached. OLD is the row's committed state and cannot be
      -- chosen by the writer, so it is the only safe basis.
      eng_id := COALESCE(OLD.engagement_id, NEW.engagement_id);
      SELECT status, legal_hold INTO eng_status, eng_hold
        FROM ngtf_audit_engagements WHERE id = eng_id;

      -- Same status list as the DELETE branch. Leaving 'report_released'
      -- out here allowed the bytes and hash behind an already-issued
      -- report to be swapped while deletion stayed blocked, and because
      -- archiving is a manual step an engagement can sit in that state
      -- indefinitely.
      locked := COALESCE(eng_status,'') IN ('archived','locked','report_released') OR COALESCE(eng_hold,FALSE);

      IF locked THEN
        IF (NEW.file_data IS DISTINCT FROM OLD.file_data)
           OR (NEW.sha256 IS DISTINCT FROM OLD.sha256)
           OR (NEW.size_bytes IS DISTINCT FROM OLD.size_bytes)
           OR (NEW.filename IS DISTINCT FROM OLD.filename)
           OR (NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at)
           OR (NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by)
           OR (NEW.version IS DISTINCT FROM OLD.version)
           OR (NEW.engagement_id IS DISTINCT FROM OLD.engagement_id)
           -- The four columns the INSERT guard exists to populate. Without
           -- them here, a post-completion-date addition could be stripped
           -- of its reason and preparer and made indistinguishable from an
           -- original workpaper.
           OR (NEW.post_archive IS DISTINCT FROM OLD.post_archive)
           OR (NEW.addition_reason IS DISTINCT FROM OLD.addition_reason)
           OR (NEW.addition_by IS DISTINCT FROM OLD.addition_by)
           OR (NEW.addition_at IS DISTINCT FROM OLD.addition_at) THEN
          RAISE EXCEPTION
            'AS 1215.16: this engagement is append-only (status=%). File content, hash, size, name, version, engagement linkage and upload/addition provenance cannot be modified. Add superseding information instead.',
            eng_status;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_audit_doc_immutable ON ngtf_audit_documents`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_audit_doc_immutable
      BEFORE UPDATE OR DELETE ON ngtf_audit_documents
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_doc_immutable();
  `);

  // Post-archive INSERTs must carry AS 1215.16 addition metadata:
  // the date added, who added it, and the reason.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_doc_post_archive_guard()
    RETURNS TRIGGER AS $$
    DECLARE
      eng_status TEXT;
    BEGIN
      SELECT status INTO eng_status FROM ngtf_audit_engagements WHERE id = NEW.engagement_id;
      IF eng_status IN ('archived','locked') THEN
        IF NEW.addition_reason IS NULL OR length(trim(NEW.addition_reason)) < 10 THEN
          RAISE EXCEPTION
            'AS 1215.16: information added after the documentation completion date must record the reason for the addition (minimum 10 characters).';
        END IF;
        IF NEW.addition_by IS NULL THEN
          RAISE EXCEPTION 'AS 1215.16: information added after the documentation completion date must record who added it.';
        END IF;
        NEW.post_archive := TRUE;
        NEW.addition_at := COALESCE(NEW.addition_at, NOW());
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_audit_doc_post_archive ON ngtf_audit_documents`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_audit_doc_post_archive
      BEFORE INSERT ON ngtf_audit_documents
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_doc_post_archive_guard();
  `);

  // Event log is append-only, always, with no exceptions. An audit
  // trail that can be edited is not an audit trail.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_events_append_only()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'ngtf_audit_events is append-only: % is not permitted on the chain-of-custody log.', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_audit_event_append ON ngtf_audit_events`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_audit_event_append
      BEFORE UPDATE OR DELETE ON ngtf_audit_events
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_events_append_only();
  `);

  // Row-level triggers DO NOT FIRE ON TRUNCATE, so the row guard above
  // was defeated entirely by `TRUNCATE ngtf_audit_events` — the whole
  // chain of custody could be erased without tripping anything. TRUNCATE
  // needs its own statement-level trigger. Same exposure on the document
  // table, so it gets one too.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_no_truncate()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION
        'TRUNCATE is not permitted on %: audit documentation and its chain of custody are retained seven years from the report release date under PCAOB AS 1215.14.',
        TG_TABLE_NAME;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_audit_events_no_truncate ON ngtf_audit_events`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_audit_events_no_truncate
      BEFORE TRUNCATE ON ngtf_audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION ngtf_audit_no_truncate();
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_audit_docs_no_truncate ON ngtf_audit_documents`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_audit_docs_no_truncate
      BEFORE TRUNCATE ON ngtf_audit_documents
      FOR EACH STATEMENT EXECUTE FUNCTION ngtf_audit_no_truncate();
  `);

  // Checklist items are evidence too — a signed negative assurance that
  // can be silently flipped after the fact is not assurance. Mirror the
  // document guard: once the engagement is archived or locked, answers,
  // waivers and satisfaction state freeze.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_item_immutable()
    RETURNS TRIGGER AS $$
    DECLARE
      eng_status TEXT;
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        SELECT status INTO eng_status FROM ngtf_audit_engagements WHERE id = OLD.engagement_id;
        IF COALESCE(eng_status,'') IN ('archived','locked') THEN
          RAISE EXCEPTION 'AS 1215.16: checklist items cannot be deleted once the engagement is archived (status=%).', eng_status;
        END IF;
        RETURN OLD;
      END IF;

      SELECT status INTO eng_status
        FROM ngtf_audit_engagements WHERE id = COALESCE(OLD.engagement_id, NEW.engagement_id);

      IF COALESCE(eng_status,'') IN ('archived','locked') THEN
        IF (NEW.status IS DISTINCT FROM OLD.status)
           OR (NEW.answer IS DISTINCT FROM OLD.answer)
           OR (NEW.answer_note IS DISTINCT FROM OLD.answer_note)
           OR (NEW.answered_by IS DISTINCT FROM OLD.answered_by)
           OR (NEW.answered_at IS DISTINCT FROM OLD.answered_at)
           OR (NEW.satisfied_by_doc IS DISTINCT FROM OLD.satisfied_by_doc)
           OR (NEW.waiver_reason IS DISTINCT FROM OLD.waiver_reason)
           OR (NEW.engagement_id IS DISTINCT FROM OLD.engagement_id) THEN
          RAISE EXCEPTION
            'AS 1215.16: this engagement is archived (status=%). Checklist answers, waivers and satisfaction state are frozen.',
            eng_status;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_audit_item_immutable ON ngtf_audit_checklist_items`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_audit_item_immutable
      BEFORE UPDATE OR DELETE ON ngtf_audit_checklist_items
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_item_immutable();
  `);

  // Backstop for the version race: at most one ACTIVE document per
  // category per engagement. Concurrent uploads previously produced two
  // rows at the same version both superseding the same parent, which
  // forks the version chain AS 1215.06 depends on.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ngtf_audit_docs_active_category
      ON ngtf_audit_documents (engagement_id, category_code)
      WHERE status = 'active' AND engagement_id IS NOT NULL AND category_code IS NOT NULL
  `).catch((err) => {
    // Pre-existing duplicates would block index creation. Don't fail boot.
    console.warn("[ngtf-audit] active-document uniqueness index not created:", err.message);
  });
}

async function seedSettings() {
  const defaults = {
    issuer: {
      name: "Nightfood Holdings, Inc.",
      ticker: "NGTF",
      cik: "0001593001",
      state_of_incorporation: "Nevada",
      fiscal_year_end: "06-30",
      filer_status: "non_accelerated",
      smaller_reporting_company: true,
      emerging_growth_company: false,
      sox_404b_required: false,
      cams_required: true,
      going_concern: true,
      segments: [
        "Foodservice Packaging Distribution (SWC Group / CarryOutSupplies.com)",
        "Robotics-as-a-Service (TechForce Robotics / RoboOp365)",
        "Hospitality Asset Ownership",
        "Snack & Beverages (discontinued as of 2025-06-30)",
      ],
      note:
        "Filer/SRC/EGC status verified from the FY2025 Form 10-K and Q3 FY2026 Form 10-Q cover " +
        "pages on EDGAR (Sept 2026). Re-verify each year at the Rule 12b-2 measurement date " +
        "(last business day of December).",
    },
    auditor: {
      firm: "TAAD, LLP",
      engaged: "2025-10-28",
      predecessor: "Fruci & Associates II, PLLC",
      predecessor_periods: "FY2024, FY2025 (both reports modified for going concern)",
      note:
        "Auditor change reported on Form 8-K Item 4.01 filed 2025-11-03 (event date 2025-10-28); " +
        "no disagreements and no reportable events disclosed. Fourth auditor change since 2022.",
    },
    deal_team: {
      securities_counsel: "Sichenzia Ross Ference Carmel LLP",
      underwriter: "Alliance Global Partners",
      note: "All IR and offering materials require securities counsel clearance while a registration statement is active.",
    },
    notifications: {
      instant_on_upload: true,
      digest_hour_local: 7,
      digest_timezone: "America/New_York",
      escalate_gate_overdue: true,
      weekly_summary_day: 1,
    },
  };

  for (const [key, value] of Object.entries(defaults)) {
    await db.query(
      `INSERT INTO ngtf_audit_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }
}

async function getSetting(key, fallback = null) {
  const r = await db.query(`SELECT value FROM ngtf_audit_settings WHERE key = $1`, [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO ngtf_audit_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// Append-only chain-of-custody write. Never throws into the caller.
async function logEvent({ documentId, engagementId, itemId, event, actor, ip, userAgent, detail }) {
  try {
    await db.query(
      `INSERT INTO ngtf_audit_events
         (document_id, engagement_id, item_id, event, actor_id, actor_email, actor_org, ip, user_agent, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        documentId || null,
        engagementId || null,
        itemId || null,
        event,
        actor ? actor.id : null,
        actor ? actor.email : null,
        actor ? actor.org : null,
        ip || null,
        userAgent || null,
        detail ? JSON.stringify(detail) : null,
      ]
    );
  } catch (err) {
    console.error("[ngtf-audit] event log write failed:", err.message);
  }
}

module.exports = {
  MAX_FILE_BYTES,
  initAuditTables,
  installImmutabilityTriggers,
  getSetting,
  setSetting,
  logEvent,
};
