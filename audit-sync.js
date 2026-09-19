// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-sync.js — DROPBOX FOLDER SCAN
//  ─────────────────────────────────────────────────────────
//  Walks the company's Dropbox folder, imports files the portal has
//  not seen, and puts every one of them in front of a human before
//  it can count as anything.
//
//  THE RULE THAT SHAPES THIS FILE
//  Synced documents land in a holding engagement that has NO
//  checklist. Not "a checklist they mostly fail" — none at all. A
//  document that satisfies nothing cannot tick a box, cannot close a
//  gate, and cannot make a period look delivered because a file with
//  a similar name happened to sit in Dropbox.
//
//  That matters because "delivered" in this portal is a factual
//  claim the auditor relies on and AS 1215 preserves. A machine that
//  found a file in a shared folder has not established that the
//  company delivered it for the audit. Only a person moving it into
//  a period establishes that, so that is the only route in.
//
//  IDEMPOTENCE
//  Every file seen is recorded by its Dropbox id and rev. A rerun
//  imports nothing it has already imported; an edited file in
//  Dropbox appears as a new rev and is imported as a new VERSION of
//  the document rather than a duplicate.
//
//  The scan never writes to Dropbox. audit-dropbox.js has no write
//  call in it.
// ============================================================

const db = require("./db");
const schema = require("./audit-schema");
const store = require("./audit-store");
const dropbox = require("./audit-dropbox");
const cal = require("./audit-calendar");

const INBOX_LABEL = "INBOX-DROPBOX";
const MAX_FILE_MB = Number(process.env.AUDIT_SYNC_MAX_FILE_MB || process.env.AUDIT_MAX_FILE_MB || 50);
const PER_RUN = Number(process.env.AUDIT_SYNC_MAX_PER_RUN || 150);

// Skip what is noise in every shared folder.
const SKIP_NAME = /^(~\$|\.|Icon\r|Thumbs\.db$|\.DS_Store$|desktop\.ini$)/i;
const SKIP_EXT = /\.(tmp|part|crdownload|lock|ini|db)$/i;

let running = false;

async function initSyncTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ngtf_audit_sync_files (
      id             SERIAL PRIMARY KEY,
      source         TEXT NOT NULL DEFAULT 'dropbox',
      remote_id      TEXT NOT NULL,
      remote_path    TEXT NOT NULL,
      remote_rev     TEXT,
      content_hash   TEXT,
      size_bytes     BIGINT,
      remote_modified TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'seen',
      document_id    INTEGER,
      error          TEXT,
      first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      imported_at    TIMESTAMPTZ,
      UNIQUE (source, remote_id, remote_rev)
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_sync_status ON ngtf_audit_sync_files (status, last_seen_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ngtf_sync_path ON ngtf_audit_sync_files (source, remote_path)`);
}

/**
 * The holding engagement: a real engagement so documents have a home
 * and a page, deliberately with no checklist so nothing can be
 * satisfied inside it.
 */
async function inbox(actor) {
  const fy = cal.fiscalYearOf(new Date());
  const found = await db.query(
    `SELECT * FROM ngtf_audit_engagements WHERE tier='inbox' AND period_label=$1`,
    [INBOX_LABEL]
  );
  if (found.rows[0]) return found.rows[0];

  const r = await db.query(
    `INSERT INTO ngtf_audit_engagements
       (fiscal_year, tier, period_label, period_name, period_end, status, headline)
     VALUES ($1,'inbox',$2,$3,NULL,'open',$4)
     RETURNING *`,
    [
      fy,
      INBOX_LABEL,
      "Imported from Dropbox — awaiting filing",
      "Documents copied from the company's Dropbox folder. Nothing here satisfies any checklist item: " +
        "a file found in a shared folder is not evidence that the company delivered it for the audit. " +
        "Review each one and file it into the period it belongs to, which is the act that makes it delivered.",
    ]
  );
  await schema.logEvent({
    engagementId: r.rows[0].id,
    event: "inbox_created",
    actor,
    detail: { source: "dropbox" },
  });
  return r.rows[0];
}

function systemActor() {
  return { id: null, name: "Dropbox sync", email: "sync@portal.local", org: "company", role: "system" };
}

async function getCursor() {
  const r = await db.query(`SELECT value FROM ngtf_audit_settings WHERE key='dropbox_cursor'`);
  return r.rows[0] ? r.rows[0].value && r.rows[0].value.cursor : null;
}

async function setCursor(cursor) {
  await db.query(
    `INSERT INTO ngtf_audit_settings (key, value) VALUES ('dropbox_cursor', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ cursor, at: new Date().toISOString() })]
  );
}

async function setStatus(patch) {
  const prev = await lastRun();
  await db.query(
    `INSERT INTO ngtf_audit_settings (key, value) VALUES ('dropbox_sync_status', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ ...(prev || {}), ...patch })]
  );
}

async function lastRun() {
  const r = await db.query(`SELECT value FROM ngtf_audit_settings WHERE key='dropbox_sync_status'`);
  return r.rows[0] ? r.rows[0].value : null;
}

/**
 * Run one scan.
 *
 * @param {object} opts
 *   full   — ignore the stored cursor and walk the whole folder
 *   actor  — who asked (a user for a manual run, the system for cron)
 */
async function run({ full = false, actor = null } = {}) {
  if (running) return { ok: false, error: "A scan is already running." };
  if (!dropbox.configured()) {
    return { ok: false, error: "Dropbox is not configured. See the sync page for the variables to set." };
  }

  running = true;
  const started = Date.now();
  const who = actor || systemActor();
  const out = { seen: 0, imported: 0, skipped: 0, failed: 0, versions: 0, errors: [] };

  try {
    await initSyncTables();
    await setStatus({ state: "running", startedAt: new Date().toISOString() });

    const cursor = full ? null : await getCursor();
    const listing = await dropbox.listAll({ cursor });
    out.seen = listing.files.length;
    out.truncated = listing.truncated;

    const holding = await inbox(who);

    for (const f of listing.files) {
      if (out.imported + out.failed >= PER_RUN) {
        out.deferred = true;
        break;
      }

      const base = f.name;
      if (SKIP_NAME.test(base) || SKIP_EXT.test(base)) {
        out.skipped++;
        continue;
      }
      if (f.size > MAX_FILE_MB * 1024 * 1024) {
        out.skipped++;
        await record(f, "skipped", null, `Larger than the ${MAX_FILE_MB}MB limit.`);
        continue;
      }

      // Already imported at this exact revision?
      const seen = await db.query(
        `SELECT id, status FROM ngtf_audit_sync_files WHERE source='dropbox' AND remote_id=$1 AND remote_rev=$2`,
        [f.id, f.rev || ""]
      );
      if (seen.rows[0] && seen.rows[0].status === "imported") {
        await db.query(`UPDATE ngtf_audit_sync_files SET last_seen_at=NOW() WHERE id=$1`, [seen.rows[0].id]);
        continue;
      }

      // Has an earlier revision of this same Dropbox file been imported?
      const prior = await db.query(
        `SELECT document_id FROM ngtf_audit_sync_files
          WHERE source='dropbox' AND remote_id=$1 AND status='imported' AND document_id IS NOT NULL
          ORDER BY imported_at DESC LIMIT 1`,
        [f.id]
      );

      try {
        const buffer = await dropbox.download(f.path);
        const res = await store.ingestDocument({
          buffer,
          filename: base,
          mimeType: guessMime(base),
          user: who,
          engagementOverride: holding.id,
          periodHint: f.modified ? cal.dstr(f.modified) : null,
          source: "dropbox",
          sourcePath: f.path,
        });

        if (res.duplicateOf) {
          out.skipped++;
          await record(f, "duplicate", res.duplicateOf.id || null, "Identical content already in the portal.");
        } else {
          out.imported++;
          if (prior.rows[0]) out.versions++;
          await record(f, "imported", res.document.id, null);
        }
      } catch (err) {
        out.failed++;
        if (out.errors.length < 12) out.errors.push(`${base}: ${err.message}`);
        await record(f, "failed", null, err.message);
      }
    }

    if (listing.cursor) await setCursor(listing.cursor);

    out.ok = true;
    out.ms = Date.now() - started;
    await setStatus({
      state: "idle",
      finishedAt: new Date().toISOString(),
      lastResult: out,
      holdingEngagementId: holding.id,
    });
    await schema.logEvent({
      engagementId: holding.id,
      event: "dropbox_sync_run",
      actor: who,
      detail: { seen: out.seen, imported: out.imported, skipped: out.skipped, failed: out.failed, full },
    });
    return out;
  } catch (err) {
    out.ok = false;
    out.error = err.message;
    await setStatus({ state: "error", finishedAt: new Date().toISOString(), error: err.message });
    console.error("[ngtf-audit sync] failed:", err.message);
    return out;
  } finally {
    running = false;
  }
}

async function record(f, status, documentId, error) {
  await db.query(
    `INSERT INTO ngtf_audit_sync_files
       (source, remote_id, remote_path, remote_rev, content_hash, size_bytes, remote_modified,
        status, document_id, error, imported_at)
     VALUES ('dropbox',$1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $7='imported' THEN NOW() ELSE NULL END)
     ON CONFLICT (source, remote_id, remote_rev) DO UPDATE
       SET last_seen_at=NOW(), status=EXCLUDED.status, document_id=COALESCE(EXCLUDED.document_id, ngtf_audit_sync_files.document_id),
           error=EXCLUDED.error`,
    [
      f.id,
      f.path,
      f.rev || "",
      f.contentHash || null,
      f.size || 0,
      f.modified || null,
      status,
      documentId,
      error ? String(error).slice(0, 500) : null,
    ]
  );
}

function guessMime(name) {
  const e = String(name).toLowerCase().split(".").pop();
  return (
    {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
      csv: "text/csv",
      txt: "text/plain",
      htm: "text/html",
      html: "text/html",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      zip: "application/zip",
    }[e] || "application/octet-stream"
  );
}

/** Recent scan activity, for the status page. */
async function recent(limit = 60) {
  await initSyncTables();
  const r = await db.query(
    `SELECT s.*, d.filename, d.category_code, d.confidence, d.needs_confirmation
       FROM ngtf_audit_sync_files s
       LEFT JOIN ngtf_audit_documents d ON d.id = s.document_id
      ORDER BY s.last_seen_at DESC, s.id DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function counts() {
  await initSyncTables();
  const r = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM ngtf_audit_sync_files GROUP BY status`
  );
  const o = {};
  r.rows.forEach((x) => (o[x.status] = x.n));
  return o;
}

module.exports = { run, recent, counts, lastRun, initSyncTables, inbox, INBOX_LABEL };
