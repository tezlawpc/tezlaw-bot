// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-delivery.js — TRANSMITTALS, RECEIPTS AND CHASING
//  ─────────────────────────────────────────────────────────
//  "We sent it." / "We never got it."
//
//  That exchange costs more days in a small-cap close than any
//  accounting question, and nothing in a shared folder can settle
//  it. A folder knows a file exists. It does not know that a named
//  person was told, that the message reached their mail server,
//  that they opened it, or that they agreed the package was
//  complete. Those are four separate facts, they fail separately,
//  and only the last one closes an item.
//
//  ── The unit of delivery is a TRANSMITTAL ──
//  A numbered package handed from one side to the other, the way a
//  law firm numbers a production: T-0001, T-0002. Numbering is the
//  cheap trick that makes the whole thing work, because it gives
//  both sides a noun. "Transmittal 14, sent the 6th, acknowledged
//  the 8th" ends an argument that "the files are in the folder"
//  cannot even begin.
//
//  Batching also matters. Twelve files uploaded in one sitting are
//  one package and one email, not twelve. A notification system
//  that pages the recipient per file is muted by week two, and a
//  muted system is WORSE than none, because it still generates a
//  record saying the auditor was notified.
//
//  ── Evidence, graded ──
//  stageOf() ranks receipt facts by what they can actually support.
//  The portal never calls a package "read" on the strength of an
//  open-tracking pixel: corporate gateways prefetch images (false
//  positive) and most clients block them (false negative), so open
//  tracking is off by default and labelled unreliable wherever it
//  appears. The receipt link carries a per-recipient token, which
//  identifies a person without granting them anything, and that is
//  both better evidence and no tracking pixel at all.
//
//  ── Nothing may sit un-notified ──
//  The failure this module was built for was not a missing feature,
//  it was a silent state: documents landed, and no procedure
//  carried that fact to the other side. So an uploaded document
//  that has never appeared on a transmittal is a TRACKED state with
//  its own alarm, and auto_transmit closes the window on its own
//  within the hour. Undelivered is a status here, not an absence.
//
//  ── Chasing is business-day arithmetic ──
//  Every interval is in business days, because every deadline this
//  portal protects is. The ladder is shallow on purpose: a few
//  nudges to the recipient, then it stops nagging them and starts
//  telling the SENDER, because an auditor sitting on a package is
//  not the auditor's problem to solve — it is the controller's
//  problem to chase. Past the stall threshold it stops being a
//  reminder and becomes a recorded delay, which is the form
//  AS 1301.25 actually requires: the auditor must communicate to
//  the audit committee any difficulties encountered, specifically
//  including delays in receiving information.
//
//  No new dependencies. crypto is built in.
// ============================================================

const crypto = require("crypto");
const db = require("./db");
const cal = require("./audit-calendar");
const schema = require("./audit-schema");
const tax = require("./audit-taxonomy");

// ── Settings ────────────────────────────────────────────────
const DEFAULTS = {
  auto_transmit: true,
  auto_transmit_after_minutes: 30,
  undelivered_alert_after_hours: 24,
  ack_due_business_days: 3,
  view_reminder_business_days: [1, 3],
  ack_reminder_business_days: [3, 6],
  stalled_business_days: 5,
  max_reminders: 4,
  escalate_to_lead_from_reminder: 2,
  email_open_tracking: false,
};

/**
 * Read the delivery settings, merged over the defaults.
 *
 * Merged rather than replaced so that adding a knob in a later version
 * does not leave every already-deployed portal with an undefined value
 * for it — which, for an interval, silently means "never".
 */
async function settings() {
  let stored = null;
  try {
    stored = await schema.getSetting("delivery", null);
  } catch {
    /* fall back to defaults */
  }
  const s = Object.assign({}, DEFAULTS, stored || {});
  // Coerce, because these arrive from a settings form as strings.
  s.auto_transmit = s.auto_transmit !== false;
  s.email_open_tracking = s.email_open_tracking === true;
  for (const k of [
    "auto_transmit_after_minutes",
    "undelivered_alert_after_hours",
    "ack_due_business_days",
    "stalled_business_days",
    "max_reminders",
    "escalate_to_lead_from_reminder",
  ]) {
    const n = Number(s[k]);
    s[k] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[k];
  }
  for (const k of ["view_reminder_business_days", "ack_reminder_business_days"]) {
    const arr = Array.isArray(s[k]) ? s[k].map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    s[k] = arr.length ? arr.sort((a, b) => a - b) : DEFAULTS[k];
  }
  return s;
}

// ── The manifest hash ───────────────────────────────────────
//
// A sha256 over the package's own ordered list of (ordinal, filename,
// file hash, size). Both sides can recompute it from what they hold,
// which turns "you never sent the October bank statement" from an
// argument into arithmetic: either that file's hash is under the
// manifest or it is not.
//
// The CANONICAL FORM is what makes it verifiable, so it is specified
// here and must not drift: one line per entry, newline-separated,
// fields pipe-separated, ordinals ascending from 1, no trailing
// newline, UTF-8. The version prefix exists so that a future change to
// the format cannot be mistaken for a tampered manifest.
const MANIFEST_FORMAT = "ngtf-transmittal-manifest/1";

function manifestLines(entries) {
  return entries.map(
    (e, i) =>
      `${i + 1}|${String(e.filename || "")}|${String(e.sha256 || "")}|${
        e.size_bytes == null ? "" : String(e.size_bytes)
      }`
  );
}

function manifestHash(entries) {
  const canonical = [MANIFEST_FORMAT].concat(manifestLines(entries)).join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Recompute from live rows, for the verify-on-screen affordance. */
function verifyManifest(transmittal, docs) {
  const recomputed = manifestHash(docs);
  return {
    stored: transmittal.manifest_sha256,
    recomputed,
    matches: recomputed === transmittal.manifest_sha256,
    format: MANIFEST_FORMAT,
  };
}

// ── Numbering ───────────────────────────────────────────────
// Gapless and sequential, because a ledger with holes in it invites the
// question of what was removed. An advisory lock held for the
// transaction serialises the read-then-insert; MAX()+1 on its own races
// two concurrent sends into the same number.
const NUMBER_LOCK_KEY = 738104231;

function formatNumber(seq) {
  return `T-${String(seq).padStart(4, "0")}`;
}

// ── Recipients ──────────────────────────────────────────────
//
// Who a package goes to is derived from the direction, not chosen each
// time, so that a package cannot quietly go to nobody. 'to' owes the
// acknowledgment; 'cc' is kept informed and is never chased.
const AUDIENCE = {
  to_auditor: { to: ["auditor_lead"], cc: ["auditor_staff"] },
  to_company: { to: ["portal_admin", "company_admin"], cc: ["company_contributor"] },
};

async function defaultRecipients(direction) {
  const spec = AUDIENCE[direction] || AUDIENCE.to_auditor;
  const r = await db.query(
    `SELECT id, email, name, org, role FROM ngtf_audit_users
      WHERE active = TRUE AND role = ANY($1) ORDER BY role, name`,
    [spec.to.concat(spec.cc)]
  );
  return r.rows.map((u) => ({
    user_id: u.id,
    email: u.email,
    name: u.name,
    org: u.org,
    kind: spec.to.includes(u.role) ? "to" : "cc",
  }));
}

async function recipientsByUserId(ids, direction) {
  if (!ids || !ids.length) return [];
  const spec = AUDIENCE[direction] || AUDIENCE.to_auditor;
  const r = await db.query(
    `SELECT id, email, name, org, role FROM ngtf_audit_users
      WHERE active = TRUE AND id = ANY($1) ORDER BY role, name`,
    [ids.map(Number).filter(Boolean)]
  );
  return r.rows.map((u) => ({
    user_id: u.id,
    email: u.email,
    name: u.name,
    org: u.org,
    // Anyone explicitly named who is not on the cc side owes an
    // acknowledgment. Otherwise a hand-picked recipient list could
    // produce a package nobody is accountable for receiving.
    kind: spec.cc.includes(u.role) ? "cc" : "to",
  }));
}

// ── Creating a transmittal ──────────────────────────────────

/**
 * Issue a package and enqueue its notification.
 *
 * The whole thing is one transaction: number, manifest, lines and
 * recipients commit together or not at all. A half-written transmittal
 * is the one outcome worse than none, because it looks like a record.
 *
 * @param {object}   a
 * @param {string}   a.direction       'to_auditor' | 'to_company'
 * @param {number}   [a.engagementId]
 * @param {number[]} [a.documentIds]   documents to enclose
 * @param {number[]} [a.itemIds]       checklist items being requested or answered
 * @param {string}   [a.subject]
 * @param {string}   [a.message]
 * @param {object[]} [a.recipients]    explicit list; defaults by direction
 * @param {number[]} [a.recipientIds]  explicit user ids; defaults by direction
 * @param {string}   [a.deliveryMethod] portal | email_attachment | courier | other
 * @param {boolean}  [a.autoGenerated]
 * @param {boolean}  [a.send]          enqueue the notification (default true)
 */
async function createTransmittal({
  direction = "to_auditor",
  engagementId = null,
  documentIds = [],
  itemIds = [],
  subject = null,
  message = null,
  recipients = null,
  recipientIds = null,
  deliveryMethod = "portal",
  methodNote = null,
  ackDueOn = null,
  autoGenerated = false,
  send = true,
  actor = null,
  req = null,
} = {}) {
  if (!["to_auditor", "to_company"].includes(direction)) {
    throw new Error(`Unknown transmittal direction "${direction}".`);
  }
  if (!["portal", "email_attachment", "courier", "other"].includes(deliveryMethod)) {
    throw new Error(`Unknown delivery method "${deliveryMethod}".`);
  }

  const cfg = await settings();
  const docIds = Array.from(new Set((documentIds || []).map(Number).filter(Boolean)));
  const itIds = Array.from(new Set((itemIds || []).map(Number).filter(Boolean)));
  if (!docIds.length && !itIds.length) {
    throw new Error("A transmittal needs at least one document or one requested item.");
  }

  let people = recipients;
  if (!people) people = recipientIds ? await recipientsByUserId(recipientIds, direction) : await defaultRecipients(direction);
  people = (people || []).filter((p) => p && p.email);
  if (!people.length) {
    // Deliberately a hard failure. A package addressed to nobody would
    // record a delivery that did not happen, which is worse than the
    // silence this module exists to remove. The caller surfaces the
    // reason — on a fresh portal it is simply that the other side has
    // no accounts yet.
    throw new Error(
      direction === "to_auditor"
        ? "No active auditor accounts exist, so there is nobody to transmit to. Create the engagement team's accounts first — until then documents will keep showing as undelivered, which is accurate."
        : "No active company accounts exist to transmit to."
    );
  }
  if (!people.some((p) => p.kind === "to")) people[0].kind = "to";

  // Pull the manifest entries. Denormalised on read, then frozen: the
  // manifest has to say what was handed over on the day it was handed
  // over, and a document can be superseded later.
  let entries = [];
  if (docIds.length) {
    const r = await db.query(
      `SELECT d.id, d.filename, d.sha256, d.size_bytes, d.version, d.category_code,
              d.engagement_id, d.needs_confirmation, d.is_gate, d.period_label
         FROM ngtf_audit_documents d
        WHERE d.id = ANY($1)
        ORDER BY d.category_code NULLS LAST, d.uploaded_at`,
      [docIds]
    );
    const found = new Set(r.rows.map((x) => x.id));
    const missing = docIds.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`No such document: ${missing.join(", ")}.`);
    entries = r.rows.map((d) => ({
      document_id: d.id,
      filename: d.filename,
      sha256: d.sha256,
      size_bytes: Number(d.size_bytes),
      version: d.version,
      category_code: d.category_code,
      category_label: d.category_code && tax.CATEGORY_BY_CODE[d.category_code]
        ? tax.CATEGORY_BY_CODE[d.category_code].label
        : d.needs_confirmation
        ? "Awaiting classification"
        : null,
      item_id: null,
      item_label: null,
      _engagement_id: d.engagement_id,
      _needs_confirmation: d.needs_confirmation,
      _is_gate: d.is_gate,
    }));
  }

  // Requested items carry no bytes, so they sit after the documents and
  // contribute an empty hash and size to the manifest. That is correct:
  // the manifest attests to files, and a request is not a file.
  if (itIds.length) {
    const r = await db.query(
      `SELECT i.id, i.label, i.category_code, i.engagement_id, i.is_gate
         FROM ngtf_audit_checklist_items i WHERE i.id = ANY($1) ORDER BY i.is_gate DESC, i.id`,
      [itIds]
    );
    for (const it of r.rows) {
      entries.push({
        document_id: null,
        filename: it.label,
        sha256: null,
        size_bytes: null,
        version: null,
        category_code: it.category_code,
        category_label: it.category_code && tax.CATEGORY_BY_CODE[it.category_code]
          ? tax.CATEGORY_BY_CODE[it.category_code].label
          : null,
        item_id: it.id,
        item_label: it.label,
        _engagement_id: it.engagement_id,
        _is_gate: it.is_gate,
      });
    }
  }

  const engId = engagementId || entries.map((e) => e._engagement_id).find(Boolean) || null;
  const docEntries = entries.filter((e) => e.document_id);
  const totalBytes = docEntries.reduce((a, e) => a + (Number(e.size_bytes) || 0), 0);
  const hash = manifestHash(entries);

  const due =
    ackDueOn ||
    cal.iso(cal.addBusinessDays(cal.parse(cal.today()), cfg.ack_due_business_days));

  const autoSubject =
    subject ||
    (direction === "to_auditor"
      ? `${docEntries.length} document${docEntries.length === 1 ? "" : "s"} for review`
      : `${itIds.length} item${itIds.length === 1 ? "" : "s"} requested`);

  const client = await db.connect();
  let tx;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [NUMBER_LOCK_KEY]);
    const seqRow = await client.query(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ngtf_audit_transmittals`);
    const seq = Number(seqRow.rows[0].n);

    const ins = await client.query(
      `INSERT INTO ngtf_audit_transmittals
         (number, seq, direction, engagement_id, subject, message, delivery_method, method_note,
          doc_count, item_count, total_bytes, manifest_sha256, ack_due_on, auto_generated, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        formatNumber(seq),
        seq,
        direction,
        engId,
        autoSubject,
        message || null,
        deliveryMethod,
        methodNote || null,
        docEntries.length,
        itIds.length,
        totalBytes,
        hash,
        due,
        !!autoGenerated,
        actor ? actor.id : null,
      ]
    );
    tx = ins.rows[0];

    let ordinal = 0;
    for (const e of entries) {
      ordinal++;
      await client.query(
        `INSERT INTO ngtf_audit_transmittal_documents
           (transmittal_id, document_id, ordinal, filename, sha256, size_bytes, version,
            category_code, category_label, item_id, item_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          tx.id,
          e.document_id,
          ordinal,
          e.filename,
          e.sha256,
          e.size_bytes,
          e.version,
          e.category_code,
          e.category_label,
          e.item_id,
          e.item_label,
        ]
      );
    }

    for (const p of people) {
      await client.query(
        `INSERT INTO ngtf_audit_transmittal_recipients
           (transmittal_id, user_id, email, name, org, kind, receipt_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (transmittal_id, email) DO NOTHING`,
        [
          tx.id,
          p.user_id || null,
          String(p.email).trim().toLowerCase(),
          p.name || null,
          p.org || null,
          p.kind === "cc" ? "cc" : "to",
          crypto.randomBytes(18).toString("hex"),
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection is going back to the pool regardless */
    }
    throw err;
  } finally {
    client.release();
  }

  await schema.logEvent({
    transmittalId: tx.id,
    engagementId: engId,
    event: "transmittal_issued",
    actor,
    ip: req ? reqIp(req) : null,
    userAgent: req ? req.headers["user-agent"] : null,
    detail: {
      number: tx.number,
      direction,
      docs: docEntries.length,
      items: itIds.length,
      manifest_sha256: hash,
      delivery_method: deliveryMethod,
      auto: !!autoGenerated,
      recipients: people.map((p) => `${p.email} (${p.kind})`),
    },
  });

  const full = await getTransmittal(tx.id);
  if (send) {
    try {
      const notify = require("./audit-notify");
      await notify.notifyTransmittal(full);
    } catch (err) {
      // The ledger entry is the record and it is already committed. A
      // failed send leaves the package visibly un-notified, which the
      // chaser will pick up — far better than losing the record because
      // the mail server was down.
      console.error("[ngtf-audit delivery] transmittal notification failed:", err.message);
    }
  }
  return await getTransmittal(tx.id);
}

function reqIp(req) {
  if (!req) return null;
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.ip || (req.socket && req.socket.remoteAddress) || null) || null;
}

// ── Reading ─────────────────────────────────────────────────

async function getTransmittal(id) {
  const t = await db.query(
    `SELECT t.*, e.period_label, e.period_name, e.tier,
            cu.name AS created_by_name, cu.email AS created_by_email,
            vu.name AS voided_by_name
       FROM ngtf_audit_transmittals t
       LEFT JOIN ngtf_audit_engagements e ON e.id = t.engagement_id
       LEFT JOIN ngtf_audit_users cu ON cu.id = t.created_by
       LEFT JOIN ngtf_audit_users vu ON vu.id = t.voided_by
      WHERE t.id = $1`,
    [id]
  );
  if (!t.rows.length) return null;
  const transmittal = t.rows[0];

  const docs = await db.query(
    `SELECT td.*, d.status AS document_status, d.supersedes_id, d.needs_confirmation,
            (SELECT COUNT(*) FROM ngtf_audit_documents nd WHERE nd.supersedes_id = td.document_id)::int AS superseded_by_count
       FROM ngtf_audit_transmittal_documents td
       LEFT JOIN ngtf_audit_documents d ON d.id = td.document_id
      WHERE td.transmittal_id = $1 ORDER BY td.ordinal`,
    [id]
  );
  const rcpts = await db.query(
    `SELECT * FROM ngtf_audit_transmittal_recipients WHERE transmittal_id = $1
      ORDER BY kind, lower(COALESCE(name, email))`,
    [id]
  );
  const events = await db.query(
    `SELECT id, event, actor_email, actor_org, ip, detail, created_at
       FROM ngtf_audit_events WHERE transmittal_id = $1 ORDER BY created_at, id`,
    [id]
  );

  const recipients = rcpts.rows.map((r) => Object.assign({}, r, { stage: stageOf(r) }));
  return {
    transmittal,
    documents: docs.rows,
    recipients,
    events: events.rows,
    manifest: verifyManifest(transmittal, docs.rows),
    rollup: rollupOf(transmittal, recipients),
  };
}

async function listTransmittals({ filter = "open", direction = null, engagementId = null, limit = 200 } = {}) {
  const where = ["1=1"];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (direction) add("t.direction = ?", direction);
  if (engagementId) add("t.engagement_id = ?", engagementId);
  if (filter === "open") where.push("t.closed_at IS NULL AND t.voided_at IS NULL");
  else if (filter === "closed") where.push("t.closed_at IS NOT NULL");
  else if (filter === "void") where.push("t.voided_at IS NOT NULL");
  else if (filter === "stalled")
    where.push(`t.voided_at IS NULL AND EXISTS (
      SELECT 1 FROM ngtf_audit_transmittal_recipients r
       WHERE r.transmittal_id = t.id AND r.stalled_at IS NOT NULL AND r.acknowledged_at IS NULL)`);
  else if (filter === "disputed")
    where.push(`EXISTS (
      SELECT 1 FROM ngtf_audit_transmittal_recipients r
       WHERE r.transmittal_id = t.id AND r.disputed_at IS NOT NULL AND r.dispute_resolved_at IS NULL)`);

  params.push(limit);
  const r = await db.query(
    `SELECT t.*, e.period_label, cu.name AS created_by_name,
            (SELECT COUNT(*) FROM ngtf_audit_transmittal_recipients r WHERE r.transmittal_id=t.id AND r.kind='to')::int AS to_count,
            (SELECT COUNT(*) FROM ngtf_audit_transmittal_recipients r WHERE r.transmittal_id=t.id AND r.kind='to' AND r.acknowledged_at IS NOT NULL)::int AS ack_count,
            (SELECT COUNT(*) FROM ngtf_audit_transmittal_recipients r WHERE r.transmittal_id=t.id AND r.kind='to' AND (r.first_viewed_at IS NOT NULL OR r.download_count > 0))::int AS viewed_count,
            (SELECT COUNT(*) FROM ngtf_audit_transmittal_recipients r WHERE r.transmittal_id=t.id AND r.email_bounced_at IS NOT NULL)::int AS bounce_count,
            (SELECT COUNT(*) FROM ngtf_audit_transmittal_recipients r WHERE r.transmittal_id=t.id AND r.disputed_at IS NOT NULL AND r.dispute_resolved_at IS NULL)::int AS dispute_count,
            (SELECT COUNT(*) FROM ngtf_audit_transmittal_recipients r WHERE r.transmittal_id=t.id AND r.stalled_at IS NOT NULL AND r.acknowledged_at IS NULL)::int AS stalled_count,
            (SELECT MAX(r.last_reminder_at) FROM ngtf_audit_transmittal_recipients r WHERE r.transmittal_id=t.id) AS last_reminder_at
       FROM ngtf_audit_transmittals t
       LEFT JOIN ngtf_audit_engagements e ON e.id = t.engagement_id
       LEFT JOIN ngtf_audit_users cu ON cu.id = t.created_by
      WHERE ${where.join(" AND ")}
      ORDER BY t.seq DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map((row) =>
    Object.assign({}, row, { ageBusinessDays: businessAge(row.created_at) })
  );
}

function businessAge(ts) {
  const d = cal.dstr(ts);
  if (!d) return 0;
  return cal.businessDaysBetween(cal.parse(d), cal.parse(cal.today()));
}

// ── Grading the evidence ────────────────────────────────────
//
// Each stage says what it can actually support, in words, because the
// whole value of this ledger is that it does not overstate. "Delivered"
// and "acknowledged" are wildly different claims and a single green tick
// for both is how a portal ends up asserting something it cannot back.
const STAGES = {
  queued:       { rank: 0, label: "Queued",        color: "#889",    weight: "Not sent yet." },
  sent:         { rank: 1, label: "Sent",          color: "#B45309", weight: "Our mail server accepted it. This says nothing about whether it arrived." },
  opened:       { rank: 2, label: "Opened (weak)", color: "#B45309", weight: "An open-tracking image loaded. Unreliable both ways — gateways prefetch it and most clients block it. Do not rely on this." },
  delivered:    { rank: 2, label: "Delivered",     color: "#2C5F8A", weight: "The recipient's mail server accepted it. This is the fact that answers “it never arrived”." },
  clicked:      { rank: 3, label: "Link clicked",  color: "#2C5F8A", weight: "The link addressed to this person was clicked. The token identifies the recipient, so this is real evidence." },
  viewed:       { rank: 4, label: "Viewed",        color: "#17706E", weight: "Opened the package in the portal while signed in as themselves." },
  downloaded:   { rank: 5, label: "Downloaded",    color: "#17706E", weight: "Took the files. The strongest observation short of a statement." },
  disputed:     { rank: 6, label: "Disputed",      color: "#9C4221", weight: "Said something is missing or wrong. A fast objection is worth more than slow silence." },
  acknowledged: { rank: 7, label: "Acknowledged",  color: "#1C7C54", weight: "Stated on the record that the package is complete. The only receipt that closes an item, because it is the only one that is a statement by them rather than an observation about them." },
  bounced:      { rank: -1, label: "BOUNCED",      color: "#991B1B", weight: "It demonstrably did NOT arrive. Fix the address and reissue — do not wait." },
};

function stageOf(r) {
  const at = (k) => (r[k] ? r[k] : null);
  let key;
  if (at("acknowledged_at")) key = "acknowledged";
  else if (at("disputed_at") && !at("dispute_resolved_at")) key = "disputed";
  else if (Number(r.download_count) > 0) key = "downloaded";
  else if (at("first_viewed_at")) key = "viewed";
  else if (at("link_clicked_at")) key = "clicked";
  // A bounce only dominates while nothing stronger has happened. If the
  // copy bounced but the person later signed in and downloaded, they got
  // it by some other route and saying BOUNCED would be false.
  else if (at("email_bounced_at")) key = "bounced";
  else if (at("email_delivered_at")) key = "delivered";
  else if (at("email_opened_at")) key = "opened";
  else if (at("email_sent_at")) key = "sent";
  else key = "queued";
  return Object.assign({ key }, STAGES[key]);
}

/** One-line state for the package as a whole. */
function rollupOf(transmittal, recipients) {
  const owed = recipients.filter((r) => r.kind === "to");
  const acked = owed.filter((r) => r.acknowledged_at);
  const disputed = recipients.filter((r) => r.disputed_at && !r.dispute_resolved_at);
  const bounced = recipients.filter((r) => r.email_bounced_at);
  const stalled = owed.filter((r) => r.stalled_at && !r.acknowledged_at);
  const seen = owed.filter((r) => r.first_viewed_at || Number(r.download_count) > 0 || r.link_clicked_at);

  let key = "awaiting";
  if (transmittal.voided_at) key = "void";
  else if (disputed.length) key = "disputed";
  else if (owed.length && acked.length === owed.length) key = "acknowledged";
  else if (bounced.length && !seen.length) key = "bounced";
  else if (stalled.length) key = "stalled";
  else if (seen.length) key = "seen";

  const LABEL = {
    void: ["Void", "#889"],
    disputed: ["Disputed", "#9C4221"],
    acknowledged: ["Acknowledged", "#1C7C54"],
    bounced: ["Did not arrive", "#991B1B"],
    stalled: ["Stalled", "#991B1B"],
    seen: ["Seen, not acknowledged", "#B45309"],
    awaiting: ["Awaiting receipt", "#B45309"],
  };
  return {
    key,
    label: LABEL[key][0],
    color: LABEL[key][1],
    owed: owed.length,
    acked: acked.length,
    seen: seen.length,
    bounced: bounced.length,
    stalled: stalled.length,
    disputed: disputed.length,
    ageBusinessDays: businessAge(transmittal.created_at),
  };
}

// ── Recording receipts ──────────────────────────────────────
//
// Every write below uses COALESCE on the "first" columns, so a repeat
// view never moves the original timestamp. The database trigger refuses
// it anyway; writing it this way means the normal path never trips the
// guard, and a trip therefore always means something is actually wrong.

/**
 * The receipt link was clicked. Identifies the recipient from the token
 * and grants nothing — the caller then sends them to sign in.
 */
async function recordLinkClick(token, req) {
  if (!token || !/^[0-9a-f]{20,80}$/.test(String(token))) return null;
  const r = await db.query(
    `UPDATE ngtf_audit_transmittal_recipients
        SET link_clicked_at = COALESCE(link_clicked_at, NOW()),
            link_clicked_ip = COALESCE(link_clicked_ip, $2)
      WHERE receipt_token = $1
      RETURNING *`,
    [String(token), reqIp(req)]
  );
  if (!r.rows.length) return null;
  const rec = r.rows[0];
  await schema.logEvent({
    transmittalId: rec.transmittal_id,
    event: "transmittal_link_clicked",
    actor: { id: rec.user_id, email: rec.email, org: rec.org },
    ip: reqIp(req),
    userAgent: req ? req.headers["user-agent"] : null,
    detail: { recipient: rec.email, firstClick: !rec.link_clicked_at },
  });
  const t = await db.query(`SELECT id, number FROM ngtf_audit_transmittals WHERE id=$1`, [rec.transmittal_id]);
  return { recipient: rec, transmittal: t.rows[0] || null };
}

/** The package was opened in the portal by a signed-in recipient. */
async function recordView({ transmittalId, user, req }) {
  if (!transmittalId || !user) return null;
  const r = await db.query(
    `UPDATE ngtf_audit_transmittal_recipients
        SET first_viewed_at = COALESCE(first_viewed_at, NOW()),
            last_viewed_at  = NOW(),
            view_count      = view_count + 1,
            user_id         = COALESCE(user_id, $3)
      WHERE transmittal_id = $1
        AND (user_id = $3 OR lower(email) = lower($2))
      RETURNING id, email, first_viewed_at, view_count`,
    [transmittalId, user.email, user.id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  // Only the FIRST view is an event. Logging every page load would bury
  // the chain of custody under refreshes.
  if (Number(row.view_count) === 1) {
    await schema.logEvent({
      transmittalId,
      event: "transmittal_viewed",
      actor: user,
      ip: reqIp(req),
      userAgent: req ? req.headers["user-agent"] : null,
      detail: { recipient: row.email },
    });
  }
  return row;
}

/**
 * A document was downloaded. Credits every live package that contained
 * it, for this person, because taking the file IS receipt of the package
 * whether or not they opened its page.
 *
 * Called from the document download route, which already logs its own
 * chain-of-custody row; this adds the delivery dimension.
 */
async function recordDownloadReceipt({ documentId, user, req }) {
  if (!documentId || !user) return [];
  const r = await db.query(
    `UPDATE ngtf_audit_transmittal_recipients r
        SET download_count   = r.download_count + 1,
            last_download_at = NOW(),
            first_viewed_at  = COALESCE(r.first_viewed_at, NOW()),
            last_viewed_at   = GREATEST(COALESCE(r.last_viewed_at, NOW()), NOW()),
            user_id          = COALESCE(r.user_id, $3)
      WHERE (r.user_id = $3 OR lower(r.email) = lower($2))
        AND r.transmittal_id IN (
          SELECT t.id FROM ngtf_audit_transmittals t
            JOIN ngtf_audit_transmittal_documents td ON td.transmittal_id = t.id
           WHERE td.document_id = $1 AND t.voided_at IS NULL)
      RETURNING r.id, r.transmittal_id, r.email, r.download_count`,
    [documentId, user.email, user.id]
  );
  for (const row of r.rows) {
    if (Number(row.download_count) === 1) {
      await schema.logEvent({
        transmittalId: row.transmittal_id,
        documentId,
        event: "transmittal_document_downloaded",
        actor: user,
        ip: reqIp(req),
        userAgent: req ? req.headers["user-agent"] : null,
        detail: { recipient: row.email },
      });
    }
  }
  return r.rows;
}

/**
 * The acknowledgment. The only receipt that closes anything, because it
 * is the only one that is a statement by the recipient rather than an
 * observation about them — which is exactly why the trigger makes it
 * final once written.
 */
async function acknowledge({ transmittalId, user, note = null, req = null }) {
  const t = await db.query(`SELECT * FROM ngtf_audit_transmittals WHERE id=$1`, [transmittalId]);
  if (!t.rows.length) throw new Error("No such transmittal.");
  if (t.rows[0].voided_at) throw new Error(`${t.rows[0].number} has been voided and cannot be acknowledged.`);

  const r = await db.query(
    `UPDATE ngtf_audit_transmittal_recipients
        SET acknowledged_at   = NOW(),
            acknowledged_note = $4,
            first_viewed_at   = COALESCE(first_viewed_at, NOW()),
            user_id           = COALESCE(user_id, $3)
      WHERE transmittal_id = $1
        AND (user_id = $3 OR lower(email) = lower($2))
        AND acknowledged_at IS NULL
      RETURNING *`,
    [transmittalId, user.email, user.id, note || null]
  );
  if (!r.rows.length) {
    // Either they are not on this package or they already signed for it.
    const mine = await db.query(
      `SELECT acknowledged_at FROM ngtf_audit_transmittal_recipients
        WHERE transmittal_id=$1 AND (user_id=$2 OR lower(email)=lower($3))`,
      [transmittalId, user.id, user.email]
    );
    if (!mine.rows.length) {
      throw new Error(
        "You are not a recipient of this transmittal, so you cannot acknowledge it. An acknowledgment has to come from the person it was addressed to or it is worth nothing."
      );
    }
    throw new Error("You have already acknowledged this transmittal, and an acknowledgment is final.");
  }

  await schema.logEvent({
    transmittalId,
    engagementId: t.rows[0].engagement_id,
    event: "transmittal_acknowledged",
    actor: user,
    ip: reqIp(req),
    userAgent: req ? req.headers["user-agent"] : null,
    detail: { recipient: r.rows[0].email, note: note || null },
  });

  await closeIfComplete(transmittalId);
  try {
    const notify = require("./audit-notify");
    await notify.notifyTransmittalAcknowledged(await getTransmittal(transmittalId), r.rows[0]);
  } catch (err) {
    console.error("[ngtf-audit delivery] acknowledgment notice failed:", err.message);
  }
  return r.rows[0];
}

/** The recipient says something is missing. Recorded, and the sender told. */
async function dispute({ transmittalId, user, note, req = null }) {
  if (!note || String(note).trim().length < 10) {
    throw new Error(
      "Say what is missing or wrong, in at least ten characters. A bare “incomplete” sends the other side looking through the whole package."
    );
  }
  const r = await db.query(
    `UPDATE ngtf_audit_transmittal_recipients
        SET disputed_at     = NOW(),
            dispute_note    = $4,
            first_viewed_at = COALESCE(first_viewed_at, NOW()),
            user_id         = COALESCE(user_id, $3)
      WHERE transmittal_id = $1
        AND (user_id = $3 OR lower(email) = lower($2))
        AND disputed_at IS NULL
      RETURNING *`,
    [transmittalId, user.email, user.id, String(note).trim()]
  );
  if (!r.rows.length) {
    throw new Error("You are not a recipient of this transmittal, or you have already raised a dispute on it.");
  }
  await schema.logEvent({
    transmittalId,
    event: "transmittal_disputed",
    actor: user,
    ip: reqIp(req),
    userAgent: req ? req.headers["user-agent"] : null,
    detail: { recipient: r.rows[0].email, note: String(note).trim() },
  });
  try {
    const notify = require("./audit-notify");
    await notify.notifyTransmittalDisputed(await getTransmittal(transmittalId), r.rows[0]);
  } catch (err) {
    console.error("[ngtf-audit delivery] dispute notice failed:", err.message);
  }
  return r.rows[0];
}

async function resolveDispute({ recipientId, user, resolution, req = null }) {
  if (!resolution || String(resolution).trim().length < 10) {
    throw new Error("Record how the dispute was resolved, in at least ten characters.");
  }
  const r = await db.query(
    `UPDATE ngtf_audit_transmittal_recipients
        SET dispute_resolved_at = NOW(), dispute_resolution = $2
      WHERE id = $1 AND disputed_at IS NOT NULL AND dispute_resolved_at IS NULL
      RETURNING *`,
    [recipientId, String(resolution).trim()]
  );
  if (!r.rows.length) throw new Error("No open dispute on that recipient.");
  await schema.logEvent({
    transmittalId: r.rows[0].transmittal_id,
    event: "transmittal_dispute_resolved",
    actor: user,
    ip: reqIp(req),
    detail: { recipient: r.rows[0].email, resolution: String(resolution).trim() },
  });
  return r.rows[0];
}

/** Everyone who owed an acknowledgment has given one. */
async function closeIfComplete(transmittalId) {
  const r = await db.query(
    `UPDATE ngtf_audit_transmittals t
        SET closed_at = NOW()
      WHERE t.id = $1 AND t.closed_at IS NULL AND t.voided_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ngtf_audit_transmittal_recipients r
           WHERE r.transmittal_id = t.id AND r.kind = 'to' AND r.acknowledged_at IS NULL)
      RETURNING id, number`,
    [transmittalId]
  );
  if (r.rows.length) {
    await schema.logEvent({
      transmittalId,
      event: "transmittal_closed",
      detail: { number: r.rows[0].number, reason: "all addressed recipients acknowledged" },
    });
  }
  return r.rows[0] || null;
}

/**
 * Withdraw a package. Not a delete: the ledger must show that something
 * went out and was then withdrawn, because the recipient saw it and the
 * gap would be the suspicious part.
 */
async function voidTransmittal({ id, user, reason, req = null }) {
  if (!reason || String(reason).trim().length < 10) {
    throw new Error("Give a reason of at least ten characters for voiding a transmittal — the ledger keeps it.");
  }
  const r = await db.query(
    `UPDATE ngtf_audit_transmittals
        SET voided_at = NOW(), void_reason = $2, voided_by = $3
      WHERE id = $1 AND voided_at IS NULL
      RETURNING *`,
    [id, String(reason).trim(), user ? user.id : null]
  );
  if (!r.rows.length) throw new Error("No such transmittal, or it is already void.");
  await schema.logEvent({
    transmittalId: id,
    engagementId: r.rows[0].engagement_id,
    event: "transmittal_voided",
    actor: user,
    ip: reqIp(req),
    detail: { number: r.rows[0].number, reason: String(reason).trim() },
  });
  return r.rows[0];
}

// ── The undelivered queue ───────────────────────────────────
//
// An active document that has never appeared on a live transmittal has
// not been delivered to anyone. It is merely stored, which is precisely
// the state that produced the problem this module exists to fix. Making
// it a QUERY rather than a flag means it cannot drift out of step with
// reality, and a document can never be marked delivered without a
// package to point at.

async function undeliveredDocuments({ engagementId = null, olderThanMinutes = 0, limit = 500 } = {}) {
  const params = [];
  const where = [
    "d.status = 'active'",
    `NOT EXISTS (
        SELECT 1 FROM ngtf_audit_transmittal_documents td
          JOIN ngtf_audit_transmittals t ON t.id = td.transmittal_id
         WHERE td.document_id = d.id AND t.voided_at IS NULL)`,
  ];
  if (engagementId) {
    params.push(engagementId);
    where.push(`d.engagement_id = $${params.length}`);
  }
  if (olderThanMinutes > 0) {
    params.push(String(olderThanMinutes));
    where.push(`d.uploaded_at < NOW() - ($${params.length} || ' minutes')::interval`);
  }
  params.push(limit);
  const r = await db.query(
    `SELECT d.id, d.filename, d.sha256, d.size_bytes, d.version, d.category_code, d.engagement_id,
            d.uploaded_at, d.period_label, d.needs_confirmation, d.is_gate, d.source,
            e.period_label AS engagement_period, e.period_name, e.status AS engagement_status,
            u.name AS uploaded_by_name
       FROM ngtf_audit_documents d
       LEFT JOIN ngtf_audit_engagements e ON e.id = d.engagement_id
       LEFT JOIN ngtf_audit_users u ON u.id = d.uploaded_by
      WHERE ${where.join(" AND ")}
      ORDER BY d.uploaded_at ASC
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map((row) =>
    Object.assign({}, row, {
      ageHours: row.uploaded_at ? Math.floor((Date.now() - new Date(row.uploaded_at).getTime()) / 3600000) : 0,
    })
  );
}

/**
 * Sweep the undelivered queue into packages, one per engagement.
 *
 * Grouped by engagement so the subject line can name the period, which
 * is the first thing an auditor needs to know. The age threshold is what
 * makes a twelve-file upload session one email rather than twelve.
 */
async function autoTransmit({ actor = null, force = false } = {}) {
  const cfg = await settings();
  if (!cfg.auto_transmit && !force) return { ran: false, reason: "auto_transmit is off" };

  const pending = await undeliveredDocuments({
    olderThanMinutes: force ? 0 : cfg.auto_transmit_after_minutes,
  });
  if (!pending.length) return { ran: true, created: [], documents: 0 };

  // An archived or locked engagement is finished; sending a package for
  // it would reopen a conversation the AS 1215 completion date closed.
  const eligible = pending.filter(
    (d) => d.engagement_id && !["archived", "locked"].includes(String(d.engagement_status || ""))
  );
  const groups = new Map();
  for (const d of eligible) {
    if (!groups.has(d.engagement_id)) groups.set(d.engagement_id, []);
    groups.get(d.engagement_id).push(d);
  }

  const created = [];
  const skipped = [];
  for (const [engId, docs] of groups) {
    try {
      const label = docs[0].period_name || docs[0].engagement_period || "the current period";
      const tx = await createTransmittal({
        direction: "to_auditor",
        engagementId: engId,
        documentIds: docs.map((d) => d.id),
        subject: `${docs.length} document${docs.length === 1 ? "" : "s"} for ${label}`,
        message:
          "Issued automatically so that nothing sits uploaded without the engagement team being told. " +
          "Please acknowledge receipt, or say what is missing.",
        autoGenerated: true,
        actor,
      });
      created.push({ id: tx.transmittal.id, number: tx.transmittal.number, docs: docs.length, engagementId: engId });
    } catch (err) {
      skipped.push({ engagementId: engId, docs: docs.length, reason: err.message });
    }
  }
  return {
    ran: true,
    created,
    skipped,
    documents: eligible.length,
    orphaned: pending.length - eligible.length,
  };
}

// ── Chasing ─────────────────────────────────────────────────

/**
 * Which reminders are due right now, and for whom.
 *
 * Split out from sending so it can be inspected without sending
 * anything — a chaser you cannot dry-run is a chaser nobody trusts to
 * leave switched on.
 */
async function dueReminders() {
  const cfg = await settings();
  const today = cal.today();
  const r = await db.query(
    `SELECT r.*, t.number, t.subject, t.direction, t.created_at AS sent_on, t.ack_due_on,
            t.engagement_id, t.doc_count, t.item_count, e.period_label
       FROM ngtf_audit_transmittal_recipients r
       JOIN ngtf_audit_transmittals t ON t.id = r.transmittal_id
       LEFT JOIN ngtf_audit_engagements e ON e.id = t.engagement_id
      WHERE t.voided_at IS NULL
        AND t.closed_at IS NULL
        AND r.kind = 'to'
        AND r.acknowledged_at IS NULL
        AND (r.disputed_at IS NULL OR r.dispute_resolved_at IS NOT NULL)
      ORDER BY t.seq`
  );

  const out = { remind: [], escalate: [], stall: [], bounced: [], skipped: [] };
  for (const row of r.rows) {
    const age = cal.businessDaysBetween(cal.parse(cal.dstr(row.sent_on)), cal.parse(today));
    const seen = !!(row.first_viewed_at || Number(row.download_count) > 0 || row.link_clicked_at);
    const ladder = seen ? cfg.ack_reminder_business_days : cfg.view_reminder_business_days;
    const stage = stageOf(row);

    // Newly past the stall threshold. Recorded once; from here it is a
    // delay in the AS 1301.25 sense rather than a reminder problem.
    if (age >= cfg.stalled_business_days && !row.stalled_at) {
      out.stall.push(Object.assign({}, row, { age, seen, stage }));
    }

    // A dead address does not get nudged again — that is shouting into a
    // void and it produces a record claiming the recipient was reminded.
    // The sender gets told instead.
    if (row.email_bounced_at && !seen) {
      out.bounced.push(Object.assign({}, row, { age, seen, stage }));
      out.skipped.push({ id: row.id, email: row.email, reason: "address bounced" });
      continue;
    }

    const earned = ladder.filter((t) => t <= age).length;
    if (earned <= Number(row.reminder_count)) {
      out.skipped.push({ id: row.id, email: row.email, reason: `no rung due (age ${age}bd, ${row.reminder_count} sent)` });
      continue;
    }
    if (Number(row.reminder_count) >= cfg.max_reminders) {
      out.skipped.push({ id: row.id, email: row.email, reason: "reminder cap reached" });
      continue;
    }
    // One per calendar day per person, whatever the ladder says. Two
    // chasing emails in a morning is how a recipient decides this portal
    // is noise.
    if (row.last_reminder_at && cal.dstr(row.last_reminder_at) === today) {
      out.skipped.push({ id: row.id, email: row.email, reason: "already reminded today" });
      continue;
    }

    // The rung is chosen by AGE, not by how many have been sent.
    //
    // A package already eight business days old that has had no reminder
    // — the normal case the first time this runs on an existing portal,
    // or after the mail server was down — should not start a polite
    // four-day ladder from the beginning. It should go straight to the
    // rung its age has earned, which means the sender's lead is copied
    // on the first message rather than a day later. Still exactly ONE
    // email: skipped rungs are marked as spent, not sent.
    const nth = Math.min(earned, cfg.max_reminders);
    out.remind.push(
      Object.assign({}, row, {
        age,
        seen,
        stage,
        nth,
        // Past this rung the recipient is no longer the audience. Copying
        // the sender's lead is what actually moves a stuck package.
        ccLead: nth >= cfg.escalate_to_lead_from_reminder,
      })
    );
  }
  return Object.assign(out, { config: cfg, today });
}

/** Send what dueReminders() found. Returns what it did, for the cron log. */
async function runChaser({ dryRun = false } = {}) {
  const due = await dueReminders();
  if (dryRun) return Object.assign({ dryRun: true }, counts(due));

  const notify = require("./audit-notify");

  for (const row of due.stall) {
    await db.query(
      `UPDATE ngtf_audit_transmittal_recipients SET stalled_at = NOW() WHERE id = $1 AND stalled_at IS NULL`,
      [row.id]
    );
    await schema.logEvent({
      transmittalId: row.transmittal_id,
      engagementId: row.engagement_id,
      event: "transmittal_stalled",
      detail: {
        number: row.number,
        recipient: row.email,
        businessDaysOutstanding: row.age,
        seenButNotAcknowledged: row.seen,
      },
    });
  }

  for (const row of due.remind) {
    try {
      await notify.notifyTransmittalReminder(row);
      // GREATEST, so the rungs the age skipped are recorded as spent and
      // are not sent later as stale catch-up mail. It also satisfies the
      // never-decrease guard on the receipt row by construction.
      await db.query(
        `UPDATE ngtf_audit_transmittal_recipients
            SET reminder_count = GREATEST(reminder_count + 1, $3),
                last_reminder_at = NOW(),
                escalated_at = CASE WHEN $2 THEN COALESCE(escalated_at, NOW()) ELSE escalated_at END
          WHERE id = $1`,
        [row.id, !!row.ccLead, Number(row.nth) || 1]
      );
      await schema.logEvent({
        transmittalId: row.transmittal_id,
        event: "transmittal_reminder_sent",
        detail: {
          number: row.number,
          recipient: row.email,
          reminder: row.nth,
          businessDaysOutstanding: row.age,
          basis: row.seen ? "seen but not acknowledged" : "not yet seen",
          copiedToSenderLead: !!row.ccLead,
        },
      });
    } catch (err) {
      console.error(`[ngtf-audit delivery] reminder failed for ${row.email}:`, err.message);
    }
  }

  // Digest of everything stuck, to the side that can do something about
  // it. Sent at most once a day by the cron that calls this.
  if (due.stall.length || due.bounced.length) {
    try {
      await notify.notifyDeliveryStalled({ stalled: due.stall, bounced: due.bounced });
    } catch (err) {
      console.error("[ngtf-audit delivery] stalled digest failed:", err.message);
    }
  }
  return counts(due);
}

function counts(due) {
  return {
    reminded: due.remind.length,
    escalated: due.remind.filter((r) => r.ccLead).length,
    stalled: due.stall.length,
    bounced: due.bounced.length,
    skipped: due.skipped.length,
  };
}

// ── AS 1301.25: difficulties encountered ────────────────────
//
// AS 1301.25 requires the auditor to communicate to the audit committee
// any difficulties encountered during the audit, and names delays in
// receiving information as an example. That communication is normally
// assembled from memory at the end of fieldwork, which is why it is
// always vague and always contested.
//
// This builds it from the ledger instead: both directions, with dates.
// It is the report that makes this feature worth something to the AUDIT
// FIRM rather than only to the company, and it is also the honest answer
// to "why were we late" — sometimes the delay is the company's and
// sometimes it is not.
async function delayReport({ engagementId = null } = {}) {
  const cfg = await settings();
  const params = [cfg.stalled_business_days];
  let engClause = "";
  if (engagementId) {
    params.push(engagementId);
    engClause = `AND t.engagement_id = $${params.length}`;
  }

  const slow = await db.query(
    `SELECT t.number, t.direction, t.subject, t.created_at, t.ack_due_on, t.doc_count, t.item_count,
            e.period_label, r.email, r.name, r.org, r.kind,
            r.first_viewed_at, r.acknowledged_at, r.email_bounced_at, r.bounce_reason,
            r.disputed_at, r.dispute_note, r.dispute_resolved_at,
            r.reminder_count, r.stalled_at, r.download_count
       FROM ngtf_audit_transmittals t
       JOIN ngtf_audit_transmittal_recipients r ON r.transmittal_id = t.id
       LEFT JOIN ngtf_audit_engagements e ON e.id = t.engagement_id
      WHERE t.voided_at IS NULL AND r.kind = 'to' ${engClause}
        AND (
          r.stalled_at IS NOT NULL
          OR r.email_bounced_at IS NOT NULL
          OR (r.disputed_at IS NOT NULL AND r.dispute_resolved_at IS NULL)
          OR (r.acknowledged_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (r.acknowledged_at - t.created_at)) / 86400.0 > $1)
        )
      ORDER BY t.seq DESC`,
    params
  );

  // The SQL above pre-filters late acknowledgments on CALENDAR days,
  // which is a cheap superset: calendar days are never fewer than
  // business days. The real test is in business days, so a package
  // acknowledged over a long weekend is not reported as a delay.
  const rows = slow.rows
    .map((x) => {
      const endIso = cal.dstr(x.acknowledged_at) || cal.today();
      return Object.assign({}, x, {
        businessDays: cal.businessDaysBetween(cal.parse(cal.dstr(x.created_at)), cal.parse(endIso)),
      });
    })
    .filter((x) => {
      if (!x.acknowledged_at) return true; // outstanding, bounced or disputed
      if (x.email_bounced_at) return true;
      if (x.disputed_at && !x.dispute_resolved_at) return true;
      return x.businessDays > cfg.stalled_business_days;
    })
    .map((x) => {
    return Object.assign({}, x, {
      stillOutstanding: !x.acknowledged_at,
      reason: x.email_bounced_at
        ? "the notification did not reach the recipient"
        : x.disputed_at && !x.dispute_resolved_at
        ? "the recipient reported the package incomplete"
        : x.acknowledged_at
        ? "acknowledged late"
        : x.first_viewed_at || Number(x.download_count) > 0
        ? "seen but not acknowledged"
        : "no response",
    });
  });

  // Open gating items belong in the same report. A gate is by definition
  // information the auditor is waiting for, and it is the clearest case
  // of the delay AS 1301.25 asks about.
  const gateParams = [];
  let gateClause = "";
  if (engagementId) {
    gateParams.push(engagementId);
    gateClause = `AND c.engagement_id = $${gateParams.length}`;
  }
  const gates = await db.query(
    `SELECT i.id, i.label, i.due_date, i.category_code, i.owner_role, c.period_label
       FROM ngtf_audit_checklist_items i
       JOIN ngtf_audit_checklists c ON c.id = i.checklist_id
      WHERE i.is_gate = TRUE AND i.status IN ('open','pending_confirmation')
        AND i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE ${gateClause}
      ORDER BY i.due_date`,
    gateParams
  );

  return {
    stalledBusinessDays: cfg.stalled_business_days,
    toAuditor: rows.filter((x) => x.direction === "to_auditor"),
    toCompany: rows.filter((x) => x.direction === "to_company"),
    openGates: gates.rows.map((g) =>
      Object.assign({}, g, {
        businessDaysLate: cal.businessDaysBetween(cal.parse(cal.dstr(g.due_date)), cal.parse(cal.today())),
      })
    ),
    generatedAt: new Date().toISOString(),
  };
}

// ── Dashboard ───────────────────────────────────────────────
async function deliveryStats() {
  const cfg = await settings();
  const q = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM ngtf_audit_transmittals WHERE voided_at IS NULL)::int AS total,
       (SELECT COUNT(*) FROM ngtf_audit_transmittals WHERE voided_at IS NULL AND closed_at IS NULL)::int AS open,
       (SELECT COUNT(DISTINCT t.id) FROM ngtf_audit_transmittals t
          JOIN ngtf_audit_transmittal_recipients r ON r.transmittal_id=t.id
         WHERE t.voided_at IS NULL AND r.kind='to' AND r.acknowledged_at IS NULL AND r.stalled_at IS NOT NULL)::int AS stalled,
       (SELECT COUNT(*) FROM ngtf_audit_transmittal_recipients WHERE email_bounced_at IS NOT NULL)::int AS bounced,
       (SELECT COUNT(DISTINCT t.id) FROM ngtf_audit_transmittals t
          JOIN ngtf_audit_transmittal_recipients r ON r.transmittal_id=t.id
         WHERE r.disputed_at IS NOT NULL AND r.dispute_resolved_at IS NULL)::int AS disputed,
       (SELECT COUNT(*) FROM ngtf_audit_users WHERE active=TRUE AND role IN ('auditor_lead','auditor_staff'))::int AS auditor_accounts`
  );
  const undelivered = await undeliveredDocuments({ limit: 1000 });
  const stale = undelivered.filter((d) => d.ageHours >= cfg.undelivered_alert_after_hours);

  // Median business days to acknowledge, over the last 25 closed
  // packages. One number that says whether the other side is responsive,
  // which is the thing a close plan actually needs to know.
  const times = await db.query(
    `SELECT t.created_at, r.acknowledged_at
       FROM ngtf_audit_transmittals t
       JOIN ngtf_audit_transmittal_recipients r ON r.transmittal_id = t.id
      WHERE r.kind='to' AND r.acknowledged_at IS NOT NULL AND t.voided_at IS NULL
      ORDER BY r.acknowledged_at DESC LIMIT 25`
  );
  const bd = times.rows
    .map((x) => cal.businessDaysBetween(cal.parse(cal.dstr(x.created_at)), cal.parse(cal.dstr(x.acknowledged_at))))
    .sort((a, b) => a - b);
  const median = bd.length ? bd[Math.floor(bd.length / 2)] : null;

  return Object.assign({}, q.rows[0], {
    undelivered: undelivered.length,
    undeliveredStale: stale.length,
    undeliveredOldestHours: undelivered.length ? undelivered[0].ageHours : 0,
    medianAckBusinessDays: median,
    ackSampleSize: bd.length,
    config: cfg,
  });
}

/** Open packages where this person still owes an acknowledgment. */
async function awaitingMe(user) {
  if (!user) return [];
  const r = await db.query(
    `SELECT t.id, t.number, t.subject, t.created_at, t.ack_due_on, t.doc_count, t.item_count,
            t.direction, e.period_label, r.first_viewed_at, r.download_count, r.reminder_count
       FROM ngtf_audit_transmittal_recipients r
       JOIN ngtf_audit_transmittals t ON t.id = r.transmittal_id
       LEFT JOIN ngtf_audit_engagements e ON e.id = t.engagement_id
      WHERE (r.user_id = $1 OR lower(r.email) = lower($2))
        AND r.kind = 'to' AND r.acknowledged_at IS NULL
        AND t.voided_at IS NULL
      ORDER BY t.seq DESC`,
    [user.id, user.email]
  );
  return r.rows;
}

/** Is this user a named recipient? Row-level, never role-level. */
async function isRecipient(transmittalId, user) {
  if (!user) return null;
  const r = await db.query(
    `SELECT * FROM ngtf_audit_transmittal_recipients
      WHERE transmittal_id = $1 AND (user_id = $2 OR lower(email) = lower($3))`,
    [transmittalId, user.id, user.email]
  );
  return r.rows[0] || null;
}

module.exports = {
  MANIFEST_FORMAT,
  DEFAULTS,
  STAGES,
  settings,
  manifestHash,
  manifestLines,
  verifyManifest,
  formatNumber,
  defaultRecipients,
  recipientsByUserId,
  createTransmittal,
  getTransmittal,
  listTransmittals,
  stageOf,
  rollupOf,
  recordLinkClick,
  recordView,
  recordDownloadReceipt,
  acknowledge,
  dispute,
  resolveDispute,
  closeIfComplete,
  voidTransmittal,
  undeliveredDocuments,
  autoTransmit,
  dueReminders,
  runChaser,
  delayReport,
  deliveryStats,
  awaitingMe,
  isRecipient,
  businessAge,
};
