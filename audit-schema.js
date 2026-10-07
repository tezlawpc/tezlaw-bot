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

  // Provenance, added additively so an already-deployed database picks
  // these up on the next boot without a migration step.
  //
  // A document that arrived through a folder scan has a different
  // evidential weight from one a person uploaded, and the record has to
  // say which. Without this the audit trail would show a NULL uploader
  // and no explanation, which is worse than either answer.
  // ── Classification training corpus ─────────────────────────
  //
  // Every human correction of a machine guess is a labelled example,
  // and it is the one asset in this system that compounds. The rules
  // are public — anyone can read Reg S-X. How a real registrant names
  // and organises its records is not public, and cannot be obtained by
  // reading the standards. After enough companies and enough periods
  // this table is the part a competitor cannot catch up on.
  //
  // Kept deliberately separate from the event log: events are an audit
  // trail under AS 1215 and must not be reshaped for machine learning,
  // and a training row needs the features the classifier actually saw.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_classification_feedback (
      id               SERIAL PRIMARY KEY,
      document_id      INTEGER,
      filename         TEXT NOT NULL,
      mime_type        TEXT,
      size_bytes       BIGINT,
      page_count       INTEGER,
      text_sample      TEXT,
      text_length      INTEGER,
      extract_engine   TEXT,
      guessed_category TEXT,
      guessed_bracket  TEXT,
      confidence       INTEGER,
      method           TEXT,
      candidates       JSONB,
      flags            JSONB,
      corrected_category TEXT,
      outcome          TEXT NOT NULL,
      corrected_by     INTEGER,
      issuer_profile   JSONB,
      period_label     TEXT,
      tier             TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_feedback_outcome ON ngtf_audit_classification_feedback (outcome, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_feedback_cats ON ngtf_audit_classification_feedback (guessed_category, corrected_category)`);

  await db.query(`ALTER TABLE ngtf_audit_documents ADD COLUMN IF NOT EXISTS source TEXT`);
  await db.query(`ALTER TABLE ngtf_audit_documents ADD COLUMN IF NOT EXISTS source_path TEXT`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_docs_source ON ngtf_audit_documents (source) WHERE source IS NOT NULL`);

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

  // ── Corporate action provenance on a checklist item ──────
  //
  // An item generated from a playbook has to carry HOW MUCH ITS DATE CAN
  // BE TRUSTED all the way to the screen. A date computed from a rule
  // whose text has been checked is not the same object as a date
  // computed from a rule believed to apply, and presenting the two
  // identically is the failure mode this whole feature exists to avoid:
  // somebody plans around a number nobody verified.
  //
  //   date_confidence  computed | approximate | unconfirmed  (NULL for
  //                    ordinary taxonomy items, which are treated as
  //                    computed)
  //   verified         whether the citation behind the step has been
  //                    checked against primary sources
  //
  // Additive columns, so an existing installation upgrades in place.
  await db.query(`ALTER TABLE ngtf_audit_checklist_items ADD COLUMN IF NOT EXISTS date_confidence TEXT`);
  await db.query(`ALTER TABLE ngtf_audit_checklist_items ADD COLUMN IF NOT EXISTS verified BOOLEAN`);
  await db.query(`ALTER TABLE ngtf_audit_checklist_items ADD COLUMN IF NOT EXISTS playbook_key TEXT`);
  await db.query(`ALTER TABLE ngtf_audit_checklist_items ADD COLUMN IF NOT EXISTS playbook_step_id TEXT`);
  await db.query(`ALTER TABLE ngtf_audit_checklist_items ADD COLUMN IF NOT EXISTS anchor_date DATE`);
  // Declaring the same action twice must not double the checklist. The
  // partial unique index is what makes the re-declare idempotent rather
  // than the application remembering to check first.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ngtf_audit_items_playbook
      ON ngtf_audit_checklist_items (checklist_id, playbook_key, playbook_step_id)
      WHERE playbook_key IS NOT NULL
  `);
  await db.query(`ALTER TABLE ngtf_audit_engagements ADD COLUMN IF NOT EXISTS action_key TEXT`);

  // ── Operating event register: the disclosure control ──────
  //
  // Rule 13a-15(e) defines disclosure controls as procedures designed to
  // ensure information "is accumulated and communicated to the issuer's
  // management ... as appropriate to allow timely decisions regarding
  // required disclosure." These three tables ARE that channel, and they
  // are built to produce evidence rather than convenience.
  //
  // In the SEC's settled orders against Blackbaud and First American the
  // violation was precisely the absence of this: operational staff knew,
  // the certifying officers did not, and no procedure carried it upward.
  // Neither order charged fraud.
  //
  // THE KNOWLEDGE TIMELINE is split deliberately into four dates:
  // occurred_on, learned_on, reported_at, notified_at. An investigation
  // reconstructs exactly that sequence, and a single "date" column
  // cannot answer "when did someone here first know, and when did the
  // officers find out."
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_event_reports (
      id                SERIAL PRIMARY KEY,
      event_key         TEXT NOT NULL,
      event_label       TEXT NOT NULL,
      summary           TEXT,
      answers           JSONB NOT NULL DEFAULT '{}'::jsonb,
      dates             JSONB NOT NULL DEFAULT '{}'::jsonb,
      -- the knowledge timeline
      occurred_on       DATE,
      learned_on        DATE,
      reported_by       INTEGER REFERENCES ngtf_audit_users(id),
      reported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notified_at       TIMESTAMPTZ,
      -- the disposition. NULL means nobody has decided yet, which is
      -- itself the thing the register chases.
      determination     TEXT,
      determination_note TEXT,
      determined_by     INTEGER REFERENCES ngtf_audit_users(id),
      determined_at     TIMESTAMPTZ,
      -- which version of the control was operating when this was taken
      catalog_version   TEXT NOT NULL,
      issuer_regime     JSONB,
      engagement_id     INTEGER REFERENCES ngtf_audit_engagements(id),
      status            TEXT NOT NULL DEFAULT 'open'
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_events_open ON ngtf_audit_event_reports (status, reported_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_events_undetermined ON ngtf_audit_event_reports (determined_at) WHERE determined_at IS NULL`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_event_obligations (
      id                SERIAL PRIMARY KEY,
      report_id         INTEGER NOT NULL REFERENCES ngtf_audit_event_reports(id) ON DELETE CASCADE,
      obligation_id     TEXT NOT NULL,
      kind              TEXT NOT NULL,
      label             TEXT NOT NULL,
      authority         TEXT[],
      item_8k           TEXT,
      anchor_key        TEXT,
      anchor_date       DATE,
      due_date          DATE,
      date_confidence   TEXT,
      verified          BOOLEAN,
      pre_act           BOOLEAN DEFAULT FALSE,
      s3_risk           BOOLEAN DEFAULT FALSE,
      severity          TEXT,
      consequence       TEXT,
      guidance          TEXT,
      owner_role        TEXT,
      doc_category      TEXT,
      status            TEXT NOT NULL DEFAULT 'open',
      satisfied_note    TEXT,
      satisfied_by      INTEGER REFERENCES ngtf_audit_users(id),
      satisfied_at      TIMESTAMPTZ,
      checklist_item_id INTEGER REFERENCES ngtf_audit_checklist_items(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (report_id, obligation_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_eventob_due ON ngtf_audit_event_obligations (due_date, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_eventob_open ON ngtf_audit_event_obligations (status, severity)`);

  // Completeness is the hard half of this control, and the ONLY way to
  // evidence it is an affirmative nil response. Silence proves nothing:
  // a register that only knows about events somebody chose to type in
  // can support "what we reported, we reported" and nothing more.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_event_attestations (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES ngtf_audit_users(id),
      period_start   DATE NOT NULL,
      period_end     DATE NOT NULL,
      answer         TEXT NOT NULL,
      note           TEXT,
      reported_ids   INTEGER[],
      catalog_version TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, period_start, period_end)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_attest_period ON ngtf_audit_event_attestations (period_end DESC, user_id)`);

  // ── Append-only enforcement ──────────────────────────────
  //
  // A control whose record can be rewritten is not a control. If an
  // operator or the CFO can change when something was reported, or what
  // was decided, the log proves nothing in an investigation and no
  // auditor will rely on it. So the knowledge timeline and the
  // determination are immutable once written, and nothing is deletable.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_event_append_only() RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'The operating event register is append-only: a reported event cannot be deleted. Record a determination instead.';
      END IF;
      IF NEW.reported_at <> OLD.reported_at
         OR NEW.reported_by IS DISTINCT FROM OLD.reported_by
         OR NEW.event_key <> OLD.event_key
         OR NEW.catalog_version <> OLD.catalog_version
         OR NEW.answers::text <> OLD.answers::text
         OR NEW.occurred_on IS DISTINCT FROM OLD.occurred_on
         OR NEW.learned_on IS DISTINCT FROM OLD.learned_on THEN
        RAISE EXCEPTION 'The knowledge timeline is immutable: when an event happened, when it was learned, who reported it and when cannot be changed after the fact. Report a correcting event instead.';
      END IF;
      IF OLD.determined_at IS NOT NULL AND (
           NEW.determination IS DISTINCT FROM OLD.determination
           OR NEW.determined_by IS DISTINCT FROM OLD.determined_by
           OR NEW.determined_at IS DISTINCT FROM OLD.determined_at) THEN
        RAISE EXCEPTION 'A recorded determination is final. Supersede it with a new reported event rather than rewriting it.';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_event_append_only ON ngtf_audit_event_reports`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_event_append_only
      BEFORE UPDATE OR DELETE ON ngtf_audit_event_reports
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_event_append_only()
  `);

  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_attest_append_only() RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'A period confirmation is evidence and cannot be changed or removed. File a new one for the next period.';
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_attest_append_only ON ngtf_audit_event_attestations`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_attest_append_only
      BEFORE UPDATE OR DELETE ON ngtf_audit_event_attestations
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_attest_append_only()
  `);

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

  await createDeliveryTables();
  await createSubledgerTables();

  await installImmutabilityTriggers();
  await seedSettings();
}

// ── Delivery ledger: who was told, and did they look ────────
//
// THE PROBLEM THIS SOLVES, stated plainly, because it is the most
// expensive dispute in an audit and the least interesting to build for:
// documents land somewhere, nobody tells the other side, and weeks later
// one party says "we sent it" and the other says "we never got it."
// Neither can prove anything, so the argument is settled by seniority
// rather than by record, and meanwhile the close slips.
//
// A shared folder cannot settle it. A folder knows a file exists; it does
// not know that a named human was told, that the message reached their
// mail server, that they opened it, or that they agreed it was complete.
// Those are four different facts and only the last one closes an item.
//
// So delivery is modelled as a TRANSMITTAL — a numbered package handed
// from one side to the other, exactly as a law firm numbers a production.
// Three tables:
//
//   ngtf_audit_transmittals             the package, with a manifest hash
//   ngtf_audit_transmittal_documents    what was in it, by name and hash
//   ngtf_audit_transmittal_recipients   per person, the receipt timeline
//
// WHY A MANIFEST HASH. The package carries a sha256 over its own ordered
// list of (filename, file hash, size). Both sides can recompute it. That
// converts "you didn't send the October bank statement" from an argument
// into arithmetic: either the statement's hash is under the manifest or
// it is not, and the manifest hash proves the list has not been edited
// since it went out.
//
// WHY THE RECEIPT TIMELINE HAS SO MANY COLUMNS. They are not degrees of
// the same thing, they are different evidence with different weight, and
// collapsing them into one "read" flag is how a portal comes to assert
// something it cannot support:
//
//   email_sent_at        our mail server accepted it. Proves nothing
//                        about the recipient.
//   email_delivered_at   the recipient's mail server accepted it. This is
//                        the fact that answers "it never arrived."
//   email_bounced_at     it demonstrably did NOT arrive. The single most
//                        valuable column here, because it is knowable on
//                        day zero instead of in week three.
//   email_opened_at      WEAK. Open tracking is a loaded image. Corporate
//                        gateways prefetch it (false positive) and most
//                        clients block it (false negative). Recorded
//                        because it is free, never relied on, and labelled
//                        as unreliable everywhere it is displayed.
//   link_clicked_at      the link addressed to this person was clicked.
//                        The token identifies the recipient, so this is
//                        real evidence, and it needs no tracking pixel.
//   first_viewed_at      they opened the package in the portal while
//                        signed in as themselves. Strong.
//   download_count       they took the files. Strongest.
//   acknowledged_at      they pressed a button saying it is complete.
//                        This is the only one that closes an item, because
//                        it is the only one that is a statement by them
//                        rather than an observation about them.
//   disputed_at          they said something is missing. Also valuable:
//                        a fast "no" beats a slow silence.
//
// The timeline is MONOTONIC and append-only by trigger. A receipt that
// can be back-dated, cleared or re-pointed is not evidence, and the whole
// reason to build this rather than rely on a mailbox is that a mailbox
// cannot be shown to be unedited.
async function createDeliveryTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_transmittals (
      id              SERIAL PRIMARY KEY,
      number          TEXT NOT NULL UNIQUE,
      seq             INTEGER NOT NULL,
      -- which way it is going decides who owes the acknowledgment
      direction       TEXT NOT NULL DEFAULT 'to_auditor',
      engagement_id   INTEGER REFERENCES ngtf_audit_engagements(id),
      subject         TEXT NOT NULL,
      message         TEXT,
      -- A package that went out by some other route still belongs in the
      -- ledger. A record that only knows about the tidy path is the same
      -- blind spot in a new costume.
      delivery_method TEXT NOT NULL DEFAULT 'portal',
      method_note     TEXT,
      doc_count       INTEGER NOT NULL DEFAULT 0,
      item_count      INTEGER NOT NULL DEFAULT 0,
      total_bytes     BIGINT NOT NULL DEFAULT 0,
      manifest_sha256 TEXT NOT NULL,
      ack_due_on      DATE,
      auto_generated  BOOLEAN NOT NULL DEFAULT FALSE,
      created_by      INTEGER REFERENCES ngtf_audit_users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at       TIMESTAMPTZ,
      voided_at       TIMESTAMPTZ,
      void_reason     TEXT,
      voided_by       INTEGER REFERENCES ngtf_audit_users(id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_tx_open ON ngtf_audit_transmittals (closed_at, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_tx_eng ON ngtf_audit_transmittals (engagement_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_tx_dir ON ngtf_audit_transmittals (direction, created_at DESC)`);

  // Filename, hash and size are DENORMALISED on purpose. The manifest has
  // to say what was handed over on the day it was handed over, and a
  // document can later be superseded by a new version. Joining through to
  // the live document row would quietly rewrite history to match the
  // present, which is the opposite of what a transmittal is for.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_transmittal_documents (
      id             SERIAL PRIMARY KEY,
      transmittal_id INTEGER NOT NULL REFERENCES ngtf_audit_transmittals(id) ON DELETE CASCADE,
      document_id    INTEGER REFERENCES ngtf_audit_documents(id),
      ordinal        INTEGER NOT NULL,
      filename       TEXT NOT NULL,
      sha256         TEXT,
      size_bytes     BIGINT,
      version        INTEGER,
      category_code  TEXT,
      category_label TEXT,
      item_id        INTEGER REFERENCES ngtf_audit_checklist_items(id),
      item_label     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // document_id is NULL on a request line (the other direction: "please
  // provide X"), and NULLs do not collide in a unique index, which is
  // exactly the behaviour wanted here.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ngtf_txdoc_doc
      ON ngtf_audit_transmittal_documents (transmittal_id, document_id)
      WHERE document_id IS NOT NULL
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_txdoc_tx ON ngtf_audit_transmittal_documents (transmittal_id, ordinal)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_txdoc_doc ON ngtf_audit_transmittal_documents (document_id)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_transmittal_recipients (
      id                  SERIAL PRIMARY KEY,
      transmittal_id      INTEGER NOT NULL REFERENCES ngtf_audit_transmittals(id) ON DELETE CASCADE,
      user_id             INTEGER REFERENCES ngtf_audit_users(id),
      email               TEXT NOT NULL,
      name                TEXT,
      org                 TEXT,
      kind                TEXT NOT NULL DEFAULT 'to',
      -- Identifies the recipient without granting them anything: clicking
      -- the link records a receipt and then sends them to sign in.
      receipt_token       TEXT NOT NULL UNIQUE,
      notified_at         TIMESTAMPTZ,
      email_sent_at       TIMESTAMPTZ,
      email_delivered_at  TIMESTAMPTZ,
      email_bounced_at    TIMESTAMPTZ,
      bounce_type         TEXT,
      bounce_reason       TEXT,
      email_opened_at     TIMESTAMPTZ,
      link_clicked_at     TIMESTAMPTZ,
      link_clicked_ip     TEXT,
      first_viewed_at     TIMESTAMPTZ,
      last_viewed_at      TIMESTAMPTZ,
      view_count          INTEGER NOT NULL DEFAULT 0,
      download_count      INTEGER NOT NULL DEFAULT 0,
      last_download_at    TIMESTAMPTZ,
      acknowledged_at     TIMESTAMPTZ,
      acknowledged_note   TEXT,
      disputed_at         TIMESTAMPTZ,
      dispute_note        TEXT,
      dispute_resolved_at TIMESTAMPTZ,
      dispute_resolution  TEXT,
      reminder_count      INTEGER NOT NULL DEFAULT 0,
      last_reminder_at    TIMESTAMPTZ,
      escalated_at        TIMESTAMPTZ,
      stalled_at          TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (transmittal_id, email)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_txrcpt_tx ON ngtf_audit_transmittal_recipients (transmittal_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_txrcpt_token ON ngtf_audit_transmittal_recipients (receipt_token)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_txrcpt_email ON ngtf_audit_transmittal_recipients (lower(email), created_at DESC)`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ngtf_txrcpt_outstanding
      ON ngtf_audit_transmittal_recipients (transmittal_id)
      WHERE acknowledged_at IS NULL AND kind = 'to'
  `);

  // The chain-of-custody log gains a transmittal dimension so a receipt
  // event sits in the same append-only place as everything else rather
  // than in a second log with its own rules.
  await db.query(`ALTER TABLE ngtf_audit_events ADD COLUMN IF NOT EXISTS transmittal_id INTEGER`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_events_tx ON ngtf_audit_events (transmittal_id, created_at DESC) WHERE transmittal_id IS NOT NULL`);

  // Lets the outbox stamp the receipt row when the mail server accepts
  // the message, and lets a provider webhook find its way back to the
  // right recipient.
  await db.query(`ALTER TABLE ngtf_audit_notifications ADD COLUMN IF NOT EXISTS receipt_id INTEGER`);
  await db.query(`ALTER TABLE ngtf_audit_notifications ADD COLUMN IF NOT EXISTS transmittal_id INTEGER`);
  await db.query(`ALTER TABLE ngtf_audit_notifications ADD COLUMN IF NOT EXISTS provider_message_id TEXT`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_audit_notif_receipt ON ngtf_audit_notifications (receipt_id) WHERE receipt_id IS NOT NULL`);

  // Raw provider callbacks, kept as received. When a delivery claim is
  // challenged the useful artefact is the provider's own words, not this
  // application's interpretation of them.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_mail_events (
      id          BIGSERIAL PRIMARY KEY,
      provider    TEXT,
      event_type  TEXT,
      recipient   TEXT,
      message_id  TEXT,
      receipt_id  INTEGER,
      matched_by  TEXT,
      payload     JSONB,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_mailev_rcpt ON ngtf_audit_mail_events (receipt_id, received_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_mailev_type ON ngtf_audit_mail_events (event_type, received_at DESC)`);
}

// ── AR / AP subledgers and audit sampling ───────────────────
//
// THE DEFICIENCY THIS ADDRESSES is not a missing report. It is that a
// receivable or a payable exists in the accounting system as a NUMBER,
// and the evidence that the number is real — the invoice, the delivery
// receipt, the cash that arrived — lives in somebody's email. When the
// auditor sends a sample selection list, that gap becomes a week of
// hunting, and the week lands in the middle of the close.
//
// WHAT THIS IS NOT. It is deliberately not an AR/AP system. The
// accounting system stays the system of record, because replacing it
// would be a year of work and the auditor would still ask for exactly
// the same things. What is missing is narrower and cheaper:
//
//   1. a FROZEN snapshot of each subledger that ties to the general
//      ledger — the first thing an auditor checks and the first thing
//      that fails;
//   2. a document index keyed to the INVOICE NUMBER, so support can be
//      found by the identifier the auditor will actually quote;
//   3. a matching engine for the selection list, so "here are our 40
//      selections" becomes a worklist instead of an archaeology project.
//
// WHY SNAPSHOTS ARE APPEND-ONLY. An aging is evidence as of a date. If
// the row that was handed over can be edited later, the tie-out it
// supported means nothing, and a reconciliation that was agreed in
// October cannot be shown to be the same one in February. A corrected
// aging is a NEW snapshot with its own version — never an edit of the
// old one. That is also how an auditor thinks about it: they tested a
// population, and the population has to still exist.
//
// WHY THE SELECTION LIST IS MODELLED SEPARATELY FROM WHO TYPED IT IN.
// In practice the auditor emails an Excel file and the controller enters
// it here. The record therefore has to distinguish the party who CHOSE
// the sample from the user who TRANSCRIBED it, and keep the auditor's
// own file as the authority. Collapsing the two would produce a record
// saying the company selected its own audit sample, which is both false
// and the sort of thing that reads very badly later.
async function createSubledgerTables() {
  // One row per (engagement, kind, as-of date) snapshot.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_subledgers (
      id               SERIAL PRIMARY KEY,
      kind             TEXT NOT NULL,                 -- 'ar' | 'ap'
      engagement_id    INTEGER REFERENCES ngtf_audit_engagements(id),
      as_of_date       DATE NOT NULL,
      period_label     TEXT,
      version          INTEGER NOT NULL DEFAULT 1,
      supersedes_id    INTEGER REFERENCES ngtf_audit_subledgers(id),
      status           TEXT NOT NULL DEFAULT 'active', -- active | superseded
      -- where it came from. The source file also goes into the document
      -- store so it satisfies its checklist item and can be transmitted.
      document_id      INTEGER REFERENCES ngtf_audit_documents(id),
      source_filename  TEXT,
      source_sha256    TEXT,
      column_map       JSONB,
      -- the population
      row_count        INTEGER NOT NULL DEFAULT 0,
      total_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
      debit_count      INTEGER NOT NULL DEFAULT 0,     -- credit balances in AR / debit balances in AP
      debit_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
      counterparty_count INTEGER NOT NULL DEFAULT 0,
      bucket_current   NUMERIC(18,2) NOT NULL DEFAULT 0,
      bucket_1_30      NUMERIC(18,2) NOT NULL DEFAULT 0,
      bucket_31_60     NUMERIC(18,2) NOT NULL DEFAULT 0,
      bucket_61_90     NUMERIC(18,2) NOT NULL DEFAULT 0,
      bucket_over_90   NUMERIC(18,2) NOT NULL DEFAULT 0,
      -- THE TIE-OUT. Entered by the company, not computed, because only
      -- the company knows what the GL says. An unexplained variance is
      -- the finding; the portal's job is to refuse to hide it.
      gl_balance       NUMERIC(18,2),
      gl_source        TEXT,
      variance         NUMERIC(18,2),
      tie_out_note     TEXT,
      tied_out         BOOLEAN NOT NULL DEFAULT FALSE,
      tied_out_by      INTEGER REFERENCES ngtf_audit_users(id),
      tied_out_at      TIMESTAMPTZ,
      -- the threshold above which a line is near-certain to be selected
      -- individually. Supplied by the auditor when they share it.
      key_item_threshold NUMERIC(18,2),
      threshold_source TEXT,
      imported_by      INTEGER REFERENCES ngtf_audit_users(id),
      imported_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note             TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_sub_kind ON ngtf_audit_subledgers (kind, as_of_date DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_sub_eng ON ngtf_audit_subledgers (engagement_id, kind, status)`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ngtf_sub_active
      ON ngtf_audit_subledgers (kind, as_of_date)
      WHERE status = 'active'
  `).catch((err) => {
    console.warn("[ngtf-audit] active-subledger uniqueness index not created:", err.message);
  });

  // The transactions. norm_doc_number is the join key that makes the
  // whole feature work: an auditor writes "Inv 1234", the accounting
  // system says "INV-0001234", and a human spends ten minutes per line
  // reconciling the two. Normalising on import does it once.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_subledger_lines (
      id                 BIGSERIAL PRIMARY KEY,
      subledger_id       INTEGER NOT NULL REFERENCES ngtf_audit_subledgers(id) ON DELETE CASCADE,
      line_no            INTEGER NOT NULL,
      counterparty_name  TEXT NOT NULL,
      counterparty_code  TEXT,
      norm_counterparty  TEXT,
      doc_number         TEXT,
      norm_doc_number    TEXT,
      norm_doc_digits    TEXT,
      doc_date           DATE,
      due_date           DATE,
      amount             NUMERIC(18,2) NOT NULL DEFAULT 0,
      open_amount        NUMERIC(18,2),
      currency           TEXT,
      days_outstanding   INTEGER,
      aging_bucket       TEXT,
      po_number          TEXT,
      reference          TEXT,
      memo               TEXT,
      is_related_party   BOOLEAN NOT NULL DEFAULT FALSE,
      is_contra_balance  BOOLEAN NOT NULL DEFAULT FALSE,
      -- why this line is likely to be picked, if it is. Stored rather
      -- than recomputed so the worklist a person worked from yesterday
      -- is the one they see today.
      risk_flags         TEXT[],
      likely_selected    BOOLEAN NOT NULL DEFAULT FALSE,
      raw                JSONB,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_subline_sub ON ngtf_audit_subledger_lines (subledger_id, line_no)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_subline_doc ON ngtf_audit_subledger_lines (subledger_id, norm_doc_number)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_subline_digits ON ngtf_audit_subledger_lines (subledger_id, norm_doc_digits)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_subline_cp ON ngtf_audit_subledger_lines (subledger_id, norm_counterparty)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_subline_amt ON ngtf_audit_subledger_lines (subledger_id, amount DESC)`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ngtf_subline_likely
      ON ngtf_audit_subledger_lines (subledger_id) WHERE likely_selected = TRUE
  `);

  // The document index: which uploaded file supports which line, and in
  // what capacity. support_type matters because the procedures need
  // different things — an invoice alone does not evidence that goods were
  // delivered, which is the whole point of AS 2310 Appendix C.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_subledger_support (
      id            SERIAL PRIMARY KEY,
      line_id       BIGINT NOT NULL REFERENCES ngtf_audit_subledger_lines(id) ON DELETE CASCADE,
      document_id   INTEGER NOT NULL REFERENCES ngtf_audit_documents(id),
      support_type  TEXT NOT NULL,
      note          TEXT,
      added_by      INTEGER REFERENCES ngtf_audit_users(id),
      added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (line_id, document_id, support_type)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_subsup_line ON ngtf_audit_subledger_support (line_id, support_type)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_subsup_doc ON ngtf_audit_subledger_support (document_id)`);

  // A selection list from the auditor.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_sample_requests (
      id                SERIAL PRIMARY KEY,
      ref               TEXT NOT NULL UNIQUE,          -- 'S-0007'
      seq               INTEGER NOT NULL,
      kind              TEXT NOT NULL,                 -- 'ar' | 'ap'
      procedure         TEXT NOT NULL,
      subledger_id      INTEGER REFERENCES ngtf_audit_subledgers(id),
      engagement_id     INTEGER REFERENCES ngtf_audit_engagements(id),
      label             TEXT NOT NULL,
      instructions      TEXT,
      required_support  TEXT[] NOT NULL DEFAULT '{}',
      -- WHO CHOSE the sample, as against who typed it in. Never the same
      -- field: the auditor selects the items under AS 2310.15 and
      -- AS 2315, and a record implying otherwise is worse than no record.
      requested_by_firm TEXT,
      requested_by_name TEXT,
      selections_source TEXT NOT NULL DEFAULT 'transcribed_from_auditor',
      source_document_id INTEGER REFERENCES ngtf_audit_documents(id),
      entered_by        INTEGER REFERENCES ngtf_audit_users(id),
      entered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      received_on       DATE,
      due_on            DATE,
      status            TEXT NOT NULL DEFAULT 'open',  -- open | complete | delivered | closed
      transmittal_id    INTEGER,
      completed_at      TIMESTAMPTZ,
      closed_at         TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_samreq_open ON ngtf_audit_sample_requests (status, due_on)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_samreq_eng ON ngtf_audit_sample_requests (engagement_id, kind)`);

  // One row per selection. An UNMATCHED selection is a finding, not a
  // user-interface inconvenience: either the auditor sampled from a
  // different population than the one they were given, or the invoice is
  // not in the aging that was handed over. Both are worth knowing in
  // week one rather than week six.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_sample_selections (
      id              SERIAL PRIMARY KEY,
      request_id      INTEGER NOT NULL REFERENCES ngtf_audit_sample_requests(id) ON DELETE CASCADE,
      selection_no    TEXT NOT NULL,
      -- exactly as the auditor wrote it, never cleaned up. If their list
      -- and the aging disagree, the disagreement is the evidence.
      given_counterparty TEXT,
      given_doc_number   TEXT,
      given_doc_date     DATE,
      given_amount       NUMERIC(18,2),
      given_note         TEXT,
      line_id         BIGINT REFERENCES ngtf_audit_subledger_lines(id),
      match_method    TEXT,
      match_note      TEXT,
      status          TEXT NOT NULL DEFAULT 'open',  -- open|partial|complete|unmatched|waived
      assigned_to     INTEGER REFERENCES ngtf_audit_users(id),
      note            TEXT,
      waiver_reason   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (request_id, selection_no)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_samsel_req ON ngtf_audit_sample_selections (request_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_samsel_line ON ngtf_audit_sample_selections (line_id)`);

  await db.query(`ALTER TABLE ngtf_audit_events ADD COLUMN IF NOT EXISTS subledger_id INTEGER`);
  await db.query(`ALTER TABLE ngtf_audit_events ADD COLUMN IF NOT EXISTS sample_request_id INTEGER`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ngtf_audit_events_sample
      ON ngtf_audit_events (sample_request_id, created_at DESC) WHERE sample_request_id IS NOT NULL
  `);
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

  // The delivery guards are installed only once their tables exist.
  // createAll() creates them first, but installImmutabilityTriggers() is
  // exported and gets called on its own during maintenance, where the
  // CREATE TRIGGER would otherwise abort the whole run and leave the
  // document and event guards reinstalled but these missing.
  try {
    await installDeliveryTriggers();
  } catch (err) {
    console.warn("[ngtf-audit] delivery ledger triggers not installed:", err.message);
  }
  try {
    await installSubledgerTriggers();
  } catch (err) {
    console.warn("[ngtf-audit] subledger triggers not installed:", err.message);
  }
}

async function installSubledgerTriggers() {
  // ── A tested population cannot be edited ──────────────────
  //
  // An aging is evidence as of a date. Once it has been tied to the
  // general ledger and handed over, the rows in it ARE the population
  // the auditor sampled from, and a population that can be edited
  // afterwards supports nothing: the reconciliation agreed in October
  // cannot be shown to be the same one in February.
  //
  // So a corrected aging is a NEW snapshot with its own version, never
  // an edit of the old one. Two columns stay writable — risk_flags and
  // likely_selected — because they are the portal's own analysis of the
  // population rather than part of it, and they legitimately change when
  // the auditor shares a different threshold.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_subline_frozen()
    RETURNS TRIGGER AS $$
    DECLARE tied BOOLEAN;
    BEGIN
      SELECT tied_out INTO tied FROM ngtf_audit_subledgers
        WHERE id = COALESCE(OLD.subledger_id, NEW.subledger_id);

      IF TG_OP = 'DELETE' THEN
        IF COALESCE(tied, FALSE) THEN
          RAISE EXCEPTION
            'This aging has been tied to the general ledger, so its rows are the population the auditor samples from and cannot be removed. Import a corrected aging as a new snapshot instead.';
        END IF;
        RETURN OLD;
      END IF;

      IF COALESCE(tied, FALSE) THEN
        IF NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name
           OR NEW.doc_number     IS DISTINCT FROM OLD.doc_number
           OR NEW.doc_date       IS DISTINCT FROM OLD.doc_date
           OR NEW.amount         IS DISTINCT FROM OLD.amount
           OR NEW.open_amount    IS DISTINCT FROM OLD.open_amount
           OR NEW.subledger_id   IS DISTINCT FROM OLD.subledger_id
           OR NEW.line_no        IS DISTINCT FROM OLD.line_no THEN
          RAISE EXCEPTION
            'This aging is tied out and frozen. A transaction''s counterparty, number, date or amount cannot be changed after the tie-out that relied on them. Import a corrected aging as a new snapshot.';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_subline_frozen ON ngtf_audit_subledger_lines`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_subline_frozen
      BEFORE UPDATE OR DELETE ON ngtf_audit_subledger_lines
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_subline_frozen();
  `);

  // The snapshot header: its identity and its agreed totals are what the
  // tie-out was. Superseding it is allowed and is the intended route.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_subledger_frozen()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'A subledger snapshot cannot be deleted. Supersede it with a corrected import — the ledger has to show which population was tested, not only the latest one.';
      END IF;
      IF NEW.kind IS DISTINCT FROM OLD.kind
         OR NEW.as_of_date IS DISTINCT FROM OLD.as_of_date
         OR NEW.imported_at IS DISTINCT FROM OLD.imported_at
         OR NEW.version IS DISTINCT FROM OLD.version THEN
        RAISE EXCEPTION 'A snapshot''s kind, as-of date, version and import time are fixed once taken.';
      END IF;
      IF COALESCE(OLD.tied_out, FALSE) THEN
        IF NEW.row_count    IS DISTINCT FROM OLD.row_count
           OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
           OR NEW.gl_balance   IS DISTINCT FROM OLD.gl_balance
           OR NEW.variance     IS DISTINCT FROM OLD.variance
           OR NEW.tied_out_by  IS DISTINCT FROM OLD.tied_out_by
           OR NEW.tied_out_at  IS DISTINCT FROM OLD.tied_out_at THEN
          RAISE EXCEPTION
            'This snapshot is tied out. The row count, the subledger total, the general-ledger balance and the variance are the reconciliation itself and are final. Supersede the snapshot instead.';
        END IF;
        IF NEW.tied_out = FALSE THEN
          RAISE EXCEPTION 'A tie-out cannot be un-done. Supersede the snapshot with a corrected import.';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_subledger_frozen ON ngtf_audit_subledgers`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_subledger_frozen
      BEFORE UPDATE OR DELETE ON ngtf_audit_subledgers
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_subledger_frozen();
  `);

  // The auditor's own words. given_* is what THEY wrote on their
  // selection list, and if their list and the aging disagree, the
  // disagreement is the evidence — so it must not be tidied up to make
  // the match work. Re-matching a line is allowed and is logged.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_selection_verbatim()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.given_counterparty IS DISTINCT FROM OLD.given_counterparty
         OR NEW.given_doc_number IS DISTINCT FROM OLD.given_doc_number
         OR NEW.given_doc_date   IS DISTINCT FROM OLD.given_doc_date
         OR NEW.given_amount     IS DISTINCT FROM OLD.given_amount
         OR NEW.selection_no     IS DISTINCT FROM OLD.selection_no
         OR NEW.request_id       IS DISTINCT FROM OLD.request_id THEN
        RAISE EXCEPTION
          'A selection is recorded as the auditor wrote it and cannot be edited. Where their list and the aging disagree, that disagreement is the finding — record it in the note rather than correcting their list.';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_selection_verbatim ON ngtf_audit_sample_selections`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_selection_verbatim
      BEFORE UPDATE ON ngtf_audit_sample_selections
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_selection_verbatim();
  `);

  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_samreq_fixed()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'A sample request cannot be deleted. Close it with a reason — the ledger has to show what was asked for.';
      END IF;
      IF NEW.ref IS DISTINCT FROM OLD.ref
         OR NEW.seq IS DISTINCT FROM OLD.seq
         OR NEW.kind IS DISTINCT FROM OLD.kind
         OR NEW.selections_source IS DISTINCT FROM OLD.selections_source
         OR NEW.entered_by IS DISTINCT FROM OLD.entered_by
         OR NEW.entered_at IS DISTINCT FROM OLD.entered_at THEN
        RAISE EXCEPTION
          'A sample request''s reference, population, and the record of who supplied and who entered the selections are fixed once issued.';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_samreq_fixed ON ngtf_audit_sample_requests`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_samreq_fixed
      BEFORE UPDATE OR DELETE ON ngtf_audit_sample_requests
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_samreq_fixed();
  `);

  for (const t of [
    "ngtf_audit_subledgers",
    "ngtf_audit_subledger_lines",
    "ngtf_audit_sample_requests",
    "ngtf_audit_sample_selections",
  ]) {
    await db.query(`DROP TRIGGER IF EXISTS trg_${t}_no_truncate ON ${t}`);
    await db.query(`
      CREATE TRIGGER trg_${t}_no_truncate
        BEFORE TRUNCATE ON ${t}
        FOR EACH STATEMENT EXECUTE FUNCTION ngtf_audit_no_truncate();
    `);
  }
}

async function installDeliveryTriggers() {
  // ── The receipt timeline is monotonic ─────────────────────
  //
  // This is the trigger that makes the delivery ledger worth more than a
  // mailbox. A sent-items folder proves nothing in a dispute because the
  // person holding it could have edited it; the question is never "do you
  // have a record" but "can the record have been changed."
  //
  // So: a receipt timestamp, once written, cannot be cleared, moved or
  // overwritten, and no counter can go down. Discovering something later
  // is always an INSERT of a later fact, never an edit of an earlier one.
  // Enforced here rather than in application code because an application
  // bug, a maintenance script or a direct psql session must not be able
  // to quietly improve the history.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_receipt_monotonic()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'A delivery receipt cannot be deleted: it is the evidence that a named person was told, and when. Void the transmittal with a reason instead.';
      END IF;

      IF NEW.transmittal_id IS DISTINCT FROM OLD.transmittal_id
         OR NEW.receipt_token IS DISTINCT FROM OLD.receipt_token
         OR lower(NEW.email) IS DISTINCT FROM lower(OLD.email) THEN
        RAISE EXCEPTION
          'A delivery receipt cannot be re-pointed to a different package or address. Add a recipient instead.';
      END IF;

      -- Once a fact is recorded it is fixed. Listed one by one rather
      -- than looped, so the error names the column an operator touched.
      IF OLD.notified_at        IS NOT NULL AND NEW.notified_at        IS DISTINCT FROM OLD.notified_at        THEN RAISE EXCEPTION 'Receipt timeline is append-only: notified_at is already recorded.';        END IF;
      IF OLD.email_sent_at      IS NOT NULL AND NEW.email_sent_at      IS DISTINCT FROM OLD.email_sent_at      THEN RAISE EXCEPTION 'Receipt timeline is append-only: email_sent_at is already recorded.';      END IF;
      IF OLD.email_delivered_at IS NOT NULL AND NEW.email_delivered_at IS DISTINCT FROM OLD.email_delivered_at THEN RAISE EXCEPTION 'Receipt timeline is append-only: email_delivered_at is already recorded.'; END IF;
      IF OLD.email_bounced_at   IS NOT NULL AND NEW.email_bounced_at   IS DISTINCT FROM OLD.email_bounced_at   THEN RAISE EXCEPTION 'Receipt timeline is append-only: a bounce is already recorded and cannot be withdrawn.'; END IF;
      IF OLD.email_opened_at    IS NOT NULL AND NEW.email_opened_at    IS DISTINCT FROM OLD.email_opened_at    THEN RAISE EXCEPTION 'Receipt timeline is append-only: email_opened_at is already recorded.';    END IF;
      IF OLD.link_clicked_at    IS NOT NULL AND NEW.link_clicked_at    IS DISTINCT FROM OLD.link_clicked_at    THEN RAISE EXCEPTION 'Receipt timeline is append-only: link_clicked_at is already recorded.';    END IF;
      IF OLD.first_viewed_at    IS NOT NULL AND NEW.first_viewed_at    IS DISTINCT FROM OLD.first_viewed_at    THEN RAISE EXCEPTION 'Receipt timeline is append-only: first_viewed_at is already recorded.';    END IF;

      -- An acknowledgment is a statement by a person. It is the one fact
      -- here that closes a checklist item, so it is the one that must be
      -- impossible to manufacture or revise after the fact.
      IF OLD.acknowledged_at IS NOT NULL AND (
           NEW.acknowledged_at   IS DISTINCT FROM OLD.acknowledged_at
           OR NEW.acknowledged_note IS DISTINCT FROM OLD.acknowledged_note) THEN
        RAISE EXCEPTION 'An acknowledgment is a statement on the record and is final. Raise a dispute or send a further transmittal instead.';
      END IF;
      IF OLD.disputed_at IS NOT NULL AND (
           NEW.disputed_at   IS DISTINCT FROM OLD.disputed_at
           OR NEW.dispute_note IS DISTINCT FROM OLD.dispute_note) THEN
        RAISE EXCEPTION 'A recorded dispute is final. Resolve it, which is recorded separately, rather than rewriting it.';
      END IF;
      IF OLD.dispute_resolved_at IS NOT NULL AND NEW.dispute_resolved_at IS DISTINCT FROM OLD.dispute_resolved_at THEN
        RAISE EXCEPTION 'Receipt timeline is append-only: the dispute resolution is already recorded.';
      END IF;

      -- Counters and "most recent" stamps may move FORWARD only.
      IF NEW.view_count     < OLD.view_count     THEN RAISE EXCEPTION 'Receipt counters cannot decrease (view_count).';     END IF;
      IF NEW.download_count < OLD.download_count THEN RAISE EXCEPTION 'Receipt counters cannot decrease (download_count).'; END IF;
      IF NEW.reminder_count < OLD.reminder_count THEN RAISE EXCEPTION 'Receipt counters cannot decrease (reminder_count).'; END IF;
      IF OLD.last_viewed_at   IS NOT NULL AND NEW.last_viewed_at   IS NOT NULL AND NEW.last_viewed_at   < OLD.last_viewed_at   THEN RAISE EXCEPTION 'last_viewed_at cannot move backwards.';   END IF;
      IF OLD.last_download_at IS NOT NULL AND NEW.last_download_at IS NOT NULL AND NEW.last_download_at < OLD.last_download_at THEN RAISE EXCEPTION 'last_download_at cannot move backwards.'; END IF;
      IF OLD.last_reminder_at IS NOT NULL AND NEW.last_reminder_at IS NOT NULL AND NEW.last_reminder_at < OLD.last_reminder_at THEN RAISE EXCEPTION 'last_reminder_at cannot move backwards.'; END IF;
      IF OLD.last_viewed_at   IS NOT NULL AND NEW.last_viewed_at   IS NULL THEN RAISE EXCEPTION 'last_viewed_at cannot be cleared.';   END IF;
      IF OLD.last_download_at IS NOT NULL AND NEW.last_download_at IS NULL THEN RAISE EXCEPTION 'last_download_at cannot be cleared.'; END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_receipt_monotonic ON ngtf_audit_transmittal_recipients`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_receipt_monotonic
      BEFORE UPDATE OR DELETE ON ngtf_audit_transmittal_recipients
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_receipt_monotonic();
  `);

  // The package itself: its identity and its manifest are what the
  // receipt is a receipt FOR. If the manifest hash can be recomputed
  // after the fact to match a changed list, the hash means nothing.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_transmittal_immutable()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'A transmittal cannot be deleted. Void it with a reason — the ledger has to show that a package went out and was then withdrawn, not that it never existed.';
      END IF;
      IF NEW.number          IS DISTINCT FROM OLD.number
         OR NEW.seq          IS DISTINCT FROM OLD.seq
         OR NEW.direction    IS DISTINCT FROM OLD.direction
         OR NEW.created_at   IS DISTINCT FROM OLD.created_at
         OR NEW.created_by   IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'A transmittal''s number, direction and origin are fixed once issued.';
      END IF;
      IF NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
         OR NEW.doc_count    IS DISTINCT FROM OLD.doc_count
         OR NEW.total_bytes  IS DISTINCT FROM OLD.total_bytes THEN
        RAISE EXCEPTION
          'The manifest of an issued transmittal is sealed. Send a further transmittal for anything that was left out — that is what the numbering is for.';
      END IF;
      IF OLD.voided_at IS NOT NULL AND (
           NEW.voided_at IS DISTINCT FROM OLD.voided_at
           OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
        RAISE EXCEPTION 'This transmittal is already void, and a void is final.';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_transmittal_immutable ON ngtf_audit_transmittals`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_transmittal_immutable
      BEFORE UPDATE OR DELETE ON ngtf_audit_transmittals
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_transmittal_immutable();
  `);

  // Manifest lines are sealed on the same reasoning. The ON DELETE
  // CASCADE on the parent is unreachable in practice because the parent
  // cannot be deleted, so this is the guard that actually holds.
  await db.query(`
    CREATE OR REPLACE FUNCTION ngtf_audit_txdoc_sealed()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION
        'A transmittal manifest is sealed when the package is issued: % is not permitted. Issue a further transmittal instead.', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_ngtf_txdoc_sealed ON ngtf_audit_transmittal_documents`);
  await db.query(`
    CREATE TRIGGER trg_ngtf_txdoc_sealed
      BEFORE UPDATE OR DELETE ON ngtf_audit_transmittal_documents
      FOR EACH ROW EXECUTE FUNCTION ngtf_audit_txdoc_sealed();
  `);

  // Row triggers do not fire on TRUNCATE, so each of these needs the
  // statement-level guard too — the same hole that was open on the event
  // log and the document table.
  for (const t of [
    "ngtf_audit_transmittals",
    "ngtf_audit_transmittal_documents",
    "ngtf_audit_transmittal_recipients",
  ]) {
    await db.query(`DROP TRIGGER IF EXISTS trg_${t}_no_truncate ON ${t}`);
    await db.query(`
      CREATE TRIGGER trg_${t}_no_truncate
        BEFORE TRUNCATE ON ${t}
        FOR EACH STATEMENT EXECUTE FUNCTION ngtf_audit_no_truncate();
    `);
  }
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
    // ── Delivery ledger behaviour ──────────────────────────
    //
    // Every interval is in BUSINESS days, because every deadline this
    // portal exists to protect is. A reminder that fires on the Sunday of
    // a long weekend has spent its one chance to be noticed.
    //
    // The ladder is deliberately shallow. Four nudges and then it stops
    // nagging the recipient and starts telling the SENDER instead, which
    // is the escalation that actually moves something: the auditor
    // ignoring a package is not the auditor's problem to solve, it is the
    // controller's problem to chase.
    delivery: {
      // Nothing may sit uploaded and un-notified. This is the gap that
      // produced the original failure: a file in a shared folder that
      // nobody was told about is not delivered, it is merely stored.
      auto_transmit: true,
      auto_transmit_after_minutes: 30,
      undelivered_alert_after_hours: 24,

      ack_due_business_days: 3,
      // Not viewed at all — the recipient may not have seen the message.
      view_reminder_business_days: [1, 3],
      // Viewed but not acknowledged — they have it; they have not agreed
      // it is complete. A different problem, so a different ladder.
      ack_reminder_business_days: [3, 6],
      // Past this, stop treating it as a reminder problem and record it
      // as a delay. AS 1301.25 requires the auditor to report to the
      // audit committee any difficulties encountered, specifically
      // including delays in receiving information.
      stalled_business_days: 5,
      max_reminders: 4,
      escalate_to_lead_from_reminder: 2,
      // Open tracking is a loaded image in the message body. It is
      // unreliable in both directions and it is a tracking pixel in
      // professional correspondence, so it is OFF unless switched on
      // deliberately. The receipt link gives better evidence anyway.
      email_open_tracking: false,
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
async function logEvent({ documentId, engagementId, itemId, transmittalId, subledgerId, sampleRequestId, event, actor, ip, userAgent, detail }) {
  try {
    await db.query(
      `INSERT INTO ngtf_audit_events
         (document_id, engagement_id, item_id, transmittal_id, subledger_id, sample_request_id,
          event, actor_id, actor_email, actor_org, ip, user_agent, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        documentId || null,
        engagementId || null,
        itemId || null,
        transmittalId || null,
        subledgerId || null,
        sampleRequestId || null,
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
  installDeliveryTriggers,
  createDeliveryTables,
  installSubledgerTriggers,
  createSubledgerTables,
  getSetting,
  setSetting,
  logEvent,
};
