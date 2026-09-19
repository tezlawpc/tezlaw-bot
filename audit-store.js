// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-store.js — ENGAGEMENTS, DOCUMENTS, CHECKLIST LOGIC
//  ─────────────────────────────────────────────────────────
//  All business rules live here so the HTTP layer stays thin and
//  the rules stay testable without a server.
//
//  Three things in this file carry most of the compliance weight:
//
//  1. VERSIONING, NOT OVERWRITING (ingestDocument)
//     A re-upload of the same category+period never replaces the
//     earlier file. It creates v2 and marks v1 'superseded' — both
//     remain retrievable. AS 1215.06 requires an experienced
//     auditor with no prior connection to reconstruct what the
//     auditor saw and when; overwriting v1 destroys exactly that.
//     Identical content (same SHA-256) is detected and refused as
//     a duplicate rather than creating a meaningless v2.
//
//  2. SWEEP SPAWNING (answerSweep)
//     A YES answer materializes the document requirements it
//     implies as real checklist items with real due dates, linked
//     back to the question that produced them. This is the
//     mechanism that catches documents nobody remembered existed.
//     A NO is recorded as signed negative assurance with the
//     answerer and timestamp — which is itself the evidence.
//
//  3. THE ARCHIVE TRANSITION (setReportReleaseDate / archive)
//     Setting the report release date starts the AS 1215.15
//     14-day clock. Archiving flips the engagement into the
//     append-only state the database triggers enforce.
// ============================================================

const crypto = require("crypto");
const db = require("./db");
const tax = require("./audit-taxonomy");
const cal = require("./audit-calendar");
const checklists = require("./audit-checklists");
const classifier = require("./audit-classifier");
const schema = require("./audit-schema");
const notify = require("./audit-notify");

// ══════════════════ MUTABILITY GATE ══════════════════
//
// The archived state was enforced only by hiding buttons in the UI.
// Every route behind those buttons still worked, so after the AS 1215.15
// documentation completion date a company user could flip a signed
// negative assurance to its opposite, waive an outstanding request, or
// silently re-file a document into a different category — changing which
// checklist item it satisfies — simply by calling the API directly.
//
// Every mutating store function now passes through here, and the
// database triggers back it up if anything ever slips past.
const FROZEN_STATUSES = ["archived", "locked"];

async function assertMutable(engagementId, action) {
  if (!engagementId) return null;
  const eng = await getEngagement(engagementId);
  if (!eng) return null;
  if (FROZEN_STATUSES.includes(eng.status)) {
    throw new Error(
      `This engagement was archived on ${cal.dstr(eng.archived_at) || "an earlier date"} and is append-only ` +
        `under AS 1215.16, so ${action} is no longer possible. Documentation may still be ADDED — with the date, ` +
        `the preparer and a reason recorded — but existing answers, waivers and classifications are frozen. ` +
        `If something here is wrong, add a superseding document explaining it rather than editing the record.`
    );
  }
  return eng;
}

// ══════════════════ ENGAGEMENTS ══════════════════

async function getEngagement(id) {
  const r = await db.query(`SELECT * FROM ngtf_audit_engagements WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function findEngagement(fiscalYear, tier, periodLabel) {
  const r = await db.query(
    `SELECT * FROM ngtf_audit_engagements WHERE fiscal_year=$1 AND tier=$2 AND period_label=$3`,
    [fiscalYear, tier, periodLabel]
  );
  return r.rows[0] || null;
}

async function listEngagements({ includeArchived = true, limit = 60 } = {}) {
  const r = await db.query(
    `SELECT e.*,
       (SELECT COUNT(*) FROM ngtf_audit_documents d WHERE d.engagement_id=e.id AND d.status='active')::int AS doc_count,
       (SELECT COUNT(*) FROM ngtf_audit_checklist_items i JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
         WHERE c.engagement_id=e.id)::int AS item_count,
       (SELECT COUNT(*) FROM ngtf_audit_checklist_items i JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
         WHERE c.engagement_id=e.id AND i.status='open')::int AS open_count,
       (SELECT COUNT(*) FROM ngtf_audit_checklist_items i JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
         WHERE c.engagement_id=e.id AND i.status='open' AND i.is_gate)::int AS open_gates,
       (SELECT COUNT(*) FROM ngtf_audit_checklist_items i JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
         WHERE c.engagement_id=e.id AND i.status='open' AND i.due_date < CURRENT_DATE)::int AS overdue_count,
       (SELECT COUNT(*) FROM ngtf_audit_comments cm WHERE cm.engagement_id=e.id AND cm.resolved=FALSE)::int AS open_notes
     FROM ngtf_audit_engagements e
     ${includeArchived ? "" : "WHERE e.status NOT IN ('archived','locked')"}
     ORDER BY e.period_end DESC NULLS LAST, e.id DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}

/**
 * Create an engagement and generate its checklist in one step.
 * Idempotent: returns the existing engagement if already present.
 */
async function openEngagement({ tier, fiscalYear, n, actor }) {
  const plan = checklists.build(tier, fiscalYear, n);
  const existing = await findEngagement(fiscalYear, tier, plan.periodLabel);
  if (existing) {
    // Make sure it has a checklist even if a prior run half-failed.
    await ensureChecklist(existing, plan);
    return { engagement: existing, created: false };
  }

  const dl = plan.filingDeadline;
  const r = await db.query(
    `INSERT INTO ngtf_audit_engagements
       (fiscal_year, tier, period_label, period_name, period_end, quarter, fiscal_month,
        status, filing_form, filing_due_date, filing_nt_due_date, filing_extended_date, headline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      fiscalYear,
      tier,
      plan.periodLabel,
      plan.periodName,
      plan.periodEnd,
      plan.quarter || null,
      plan.fiscalMonth || null,
      dl ? dl.form : null,
      dl ? dl.dueDate : null,
      dl ? dl.ntDueBy : null,
      dl ? dl.extendedDueDate : null,
      plan.headline,
    ]
  );
  const eng = r.rows[0];
  await ensureChecklist(eng, plan);
  await schema.logEvent({
    engagementId: eng.id,
    event: "engagement_opened",
    actor,
    detail: { tier, fiscalYear, periodLabel: plan.periodLabel, items: plan.items.length },
  });
  await notify.notifyEngagementEvent({ engagement: eng, event: "opened", actor, detail: { items: plan.items.length } });
  return { engagement: eng, created: true };
}

async function ensureChecklist(engagement, plan) {
  const existing = await db.query(
    `SELECT * FROM ngtf_audit_checklists WHERE fiscal_year=$1 AND tier=$2 AND period_label=$3`,
    [engagement.fiscal_year, engagement.tier, engagement.period_label]
  );
  if (existing.rows.length) return existing.rows[0];

  const p = plan || checklists.build(engagement.tier, engagement.fiscal_year, engagement.quarter || engagement.fiscal_month);
  const cl = (
    await db.query(
      `INSERT INTO ngtf_audit_checklists
         (engagement_id, tier, fiscal_year, period_label, period_name, period_end, headline, filing_due_date, target_complete_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        engagement.id,
        p.tier,
        p.fiscalYear,
        p.periodLabel,
        p.periodName,
        p.periodEnd,
        p.headline,
        p.filingDeadline ? p.filingDeadline.dueDate : null,
        p.targetCompleteBy,
      ]
    )
  ).rows[0];

  for (const item of p.items) {
    await db.query(
      `INSERT INTO ngtf_audit_checklist_items
         (checklist_id, engagement_id, kind, category_code, bracket_code, sweep_id, label,
          authority, why, note, owner_role, due_date, is_gate, sensitive, spawn_codes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        cl.id,
        engagement.id,
        item.kind,
        item.categoryCode || null,
        item.bracketCode || null,
        item.sweepId || null,
        item.label,
        item.authority || null,
        item.why || null,
        item.note || null,
        item.owner || null,
        item.dueDate || null,
        !!item.isGate,
        !!item.sensitive,
        item.spawns || null,
      ]
    );
  }

  // Back-satisfy any documents already uploaded for this period.
  await reconcileChecklist(cl.id);
  return cl;
}

/** Tick any item that already has a matching active document. */
async function reconcileChecklist(checklistId) {
  // Scoped to the checklist's OWN engagement. Matching on category plus
  // period_label alone let a document belonging to a different
  // engagement — including one with engagement_id NULL — satisfy this
  // checklist, and when several rows matched Postgres picked one
  // arbitrarily, so satisfied_by_doc was non-deterministic. Ordering by
  // version then upload time makes the choice explicit: the newest
  // active version wins.
  const r = await db.query(
    `UPDATE ngtf_audit_checklist_items i
        SET status = 'satisfied',
            satisfied_by_doc = (
              SELECT d.id FROM ngtf_audit_documents d
               WHERE d.engagement_id = i.engagement_id
                 AND d.category_code = i.category_code
                 AND d.status = 'active'
               ORDER BY d.version DESC, d.uploaded_at DESC LIMIT 1
            ),
            satisfied_at = (
              SELECT d.uploaded_at FROM ngtf_audit_documents d
               WHERE d.engagement_id = i.engagement_id
                 AND d.category_code = i.category_code
                 AND d.status = 'active'
               ORDER BY d.version DESC, d.uploaded_at DESC LIMIT 1
            )
      WHERE i.checklist_id = $1
        AND i.kind = 'document'
        AND i.status = 'open'
        AND i.category_code IS NOT NULL
        AND i.engagement_id IS NOT NULL
        AND EXISTS (
              SELECT 1 FROM ngtf_audit_documents d
               WHERE d.engagement_id = i.engagement_id
                 AND d.category_code = i.category_code
                 AND d.status = 'active'
            )
      RETURNING i.id`,
    [checklistId]
  );
  return r.rowCount;
}

async function setReportReleaseDate(engagementId, dateStr, actor) {
  const info = cal.documentationCompletionDate(dateStr);
  if (!info) throw new Error("Invalid report release date — use YYYY-MM-DD.");
  // Validate FIRST. The chain-of-custody log is append-only by design,
  // so a write against a nonexistent engagement leaves a permanent,
  // uncorrectable "report released" entry that never happened.
  const exists = await getEngagement(engagementId);
  if (!exists) throw new Error(`Engagement ${engagementId} not found.`);
  const r = await db.query(
    `UPDATE ngtf_audit_engagements
        SET report_release_date=$1, doc_completion_date=$2, retention_expiry=$3,
            status = CASE WHEN status IN ('archived','locked') THEN status ELSE 'report_released' END
      WHERE id=$4 RETURNING *`,
    [info.reportReleaseDate, info.completionDate, info.retentionExpiry, engagementId]
  );
  const eng = r.rows[0];
  await schema.logEvent({ engagementId, event: "report_released", actor, detail: info });
  await notify.notifyEngagementEvent({
    engagement: eng,
    event: "report_released",
    actor,
    detail: {
      "Documentation completion date (AS 1215.15)": info.completionDate,
      "Retention through (AS 1215.14)": info.retentionExpiry,
    },
  });
  return eng;
}

/**
 * Archive → append-only. The database triggers enforce it from here;
 * this just flips the flag and tells everyone.
 */
async function archiveEngagement(engagementId, actor) {
  const eng = await getEngagement(engagementId);
  if (!eng) throw new Error("Engagement not found");
  if (!eng.report_release_date) {
    throw new Error(
      "Set the report release date before archiving — AS 1215.15 measures the 14-day documentation " +
        "completion window from report release, and AS 1215.14 measures the 7-year retention period from " +
        "the same date."
    );
  }
  const openGates = await db.query(
    `SELECT COUNT(*)::int AS n FROM ngtf_audit_checklist_items i
       JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
      WHERE c.engagement_id=$1 AND i.status='open' AND i.is_gate`,
    [engagementId]
  );
  const r = await db.query(
    `UPDATE ngtf_audit_engagements SET status='archived', archived_at=NOW() WHERE id=$1 RETURNING *`,
    [engagementId]
  );
  await schema.logEvent({
    engagementId,
    event: "engagement_archived",
    actor,
    detail: { openGatesAtArchive: openGates.rows[0].n },
  });
  await notify.notifyEngagementEvent({
    engagement: r.rows[0],
    event: "archived",
    actor,
    detail: { "Open gating items at archive": openGates.rows[0].n },
  });
  return r.rows[0];
}

async function setLegalHold(engagementId, on, reason, actor) {
  const exists = await getEngagement(engagementId);
  if (!exists) throw new Error(`Engagement ${engagementId} not found.`);
  const r = await db.query(
    `UPDATE ngtf_audit_engagements SET legal_hold=$1, legal_hold_reason=$2 WHERE id=$3 RETURNING *`,
    [!!on, reason || null, engagementId]
  );
  await schema.logEvent({ engagementId, event: on ? "legal_hold_applied" : "legal_hold_released", actor, detail: { reason } });
  if (on) await notify.notifyEngagementEvent({ engagement: r.rows[0], event: "legal_hold", actor, detail: { reason } });
  return r.rows[0];
}

// ══════════════════ DOCUMENT INTAKE ══════════════════

/**
 * The main upload path: classify → route → version → satisfy the
 * checklist item → notify the auditor.
 *
 * Returns { document, classification, satisfiedItems, duplicateOf }.
 */
async function ingestDocument({
  buffer,
  filename,
  mimeType,
  user,
  periodHint = null,
  categoryOverride = null,
  engagementOverride = null,
  additionReason = null,
  req = null,
}) {
  if (!buffer || !buffer.length) throw new Error("Empty file");
  if (buffer.length > schema.MAX_FILE_BYTES) {
    throw new Error(
      `File is ${(buffer.length / 1024 / 1024).toFixed(1)}MB — the limit is ${(
        schema.MAX_FILE_BYTES /
        1024 /
        1024
      ).toFixed(0)}MB. Split large GL extracts by month or by account range.`
    );
  }

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  // Classify (or accept an explicit override from the uploader).
  let cls;
  if (categoryOverride && tax.CATEGORY_BY_CODE[categoryOverride]) {
    const periods = cal.resolvePeriods(periodHint || new Date());
    const cat = tax.CATEGORY_BY_CODE[categoryOverride];

    // Pick the tier from the DATE first, not from the category's
    // preference order. A date that is a fiscal year end means the
    // annual package; a quarter end means the interim review. Only when
    // the date says nothing does the category's own preference decide.
    // Getting this backwards files a quarter-end deliverable into the
    // monthly close folder.
    const hinted = periodHint ? cal.sniffPeriod(cal.dstr(periodHint)) : null;
    const dateTier = hinted && hinted.inferredTier ? hinted.inferredTier : null;
    const tier =
      dateTier && cat.tiers.includes(dateTier)
        ? dateTier
        : cat.tiers.includes("monthly")
        ? "monthly"
        : cat.tiers.includes("quarterly")
        ? "quarterly"
        : cat.tiers[0];
    const label = tier === "annual" ? periods.annual.label : tier === "quarterly" ? periods.quarter.label : periods.month.label;
    cls = {
      classified: true,
      categoryCode: categoryOverride,
      categoryLabel: cat.label,
      bracketCode: cat.bracket,
      bracketLabel: tax.BRACKET_BY_CODE[cat.bracket].label,
      folderPath: tax.folderPath(categoryOverride, { fiscalYear: periods.fiscalYear, periodLabel: label }),
      tier,
      period: {
        fiscalYear: periods.fiscalYear,
        asOf: periodHint || null,
        periodLabel: label,
        quarterLabel: periods.quarter.label,
        monthLabel: periods.month.label,
        annualLabel: periods.annual.label,
        source: "manual override",
      },
      confidence: 100,
      method: "manual",
      needsConfirmation: false,
      isGate: !!cat.gate,
      isConfidential: !!cat.conf,
      authority: cat.authority || [],
      brief: null,
      flags: [],
      candidates: [],
      reasoningTrail: ["category set manually by uploader"],
    };
    // Still generate a brief so the auditor notification is useful.
    try {
      const auto = await classifier.classify({ filename, buffer, mimeType, sizeBytes: buffer.length, periodHint });
      cls.brief = auto.brief;
      cls.flags = auto.flags || [];
      if (auto.categoryCode && auto.categoryCode !== categoryOverride) {
        cls.reasoningTrail.push(`classifier would have chosen ${auto.categoryCode} (${auto.confidence}%)`);
      }
    } catch {
      /* brief is optional */
    }
  } else {
    cls = await classifier.classify({ filename, buffer, mimeType, sizeBytes: buffer.length, periodHint });
  }

  // Resolve the engagement.
  //
  // An explicit engagement wins over everything. This matters more than
  // it looks: a document dated 2026-09-30 legitimately belongs to EITHER
  // the September monthly close OR the Q1 interim review, and no amount
  // of inference can settle which one the preparer meant. Guessing sends
  // the quarterly review package into the monthly folder, where the
  // auditor will not find it. So the uploader can just say.
  let fy, tier, periodLabel;
  let engagement = null;

  if (engagementOverride) {
    engagement = await getEngagement(Number(engagementOverride));
    if (!engagement) throw new Error(`Engagement ${engagementOverride} not found.`);
    fy = engagement.fiscal_year;
    tier = engagement.tier;
    periodLabel = engagement.period_label;
    // Re-derive the designated folder for the chosen period, so the
    // path reflects where it actually landed rather than where the
    // classifier guessed.
    if (cls.categoryCode) {
      cls.folderPath = tax.folderPath(cls.categoryCode, { fiscalYear: fy, periodLabel });
      cls.tier = tier;
      cls.period = { ...(cls.period || {}), fiscalYear: fy, periodLabel, source: "engagement chosen by uploader" };
    }
  } else {
    fy = cls.period ? cls.period.fiscalYear : cal.fiscalYearOf(new Date());
    tier = cls.tier || "monthly";
    periodLabel = cls.period ? cls.period.periodLabel : cal.resolvePeriods(new Date()).month.label;
    engagement = await findEngagement(fy, tier, periodLabel);
  }

  if (!engagement) {
    const n =
      tier === "quarterly"
        ? Number(String(periodLabel).match(/^Q(\d)/)?.[1] || 1)
        : tier === "monthly"
        ? Number(String(periodLabel).match(/^M(\d+)/)?.[1] || 1)
        : null;
    try {
      const res = await openEngagement({ tier, fiscalYear: fy, n, actor: user });
      engagement = res.engagement;
    } catch (err) {
      // Previously this was swallowed and the upload continued with
      // engagement_id NULL: the API returned ok, the uploader believed
      // the PBC item was delivered, and the document was attached to
      // nothing and appeared on no engagement page. Failing loudly is
      // the kinder outcome.
      console.error("[ngtf-audit] auto-open engagement failed:", err.message);
      throw new Error(
        `Could not open the ${tier} engagement for ${periodLabel} to file this document against ` +
          `(${err.message}). Create the period from the Calendar first, or choose an existing period on the ` +
          `upload page, then try again. The file was not stored.`
      );
    }
  }

  // Duplicate detection — SCOPED TO THE RESOLVED ENGAGEMENT.
  //
  // A global hash check looked tidier but broke the one workflow the
  // upload page explicitly tells people to use: the same bank
  // reconciliation legitimately belongs to BOTH the September monthly
  // close and the Q1 interim review, and a global check refused the
  // second filing, so that period's checklist item was never satisfied
  // and the auditor was never told the document existed for it.
  // Identity is the file within a period, not the file in the world.
  if (engagement) {
    const dupe = await db.query(
      `SELECT d.id, d.filename, d.version, d.uploaded_at, d.category_code, d.period_label
         FROM ngtf_audit_documents d
        WHERE d.sha256=$1 AND d.status='active' AND d.engagement_id=$2 LIMIT 1`,
      [sha256, engagement.id]
    );
    if (dupe.rows.length) {
      const prior = dupe.rows[0];
      await schema.logEvent({
        documentId: prior.id,
        engagementId: engagement.id,
        event: "duplicate_upload_rejected",
        actor: user,
        detail: { filename, sha256, existingAs: prior.filename },
      });
      return {
        duplicateOf: prior,
        document: null,
        classification: cls,
        engagement,
        satisfiedItems: [],
        message:
          `Identical file already on record for ${engagement.period_label} as "${prior.filename}" ` +
          `(v${prior.version}, ${prior.category_code || "unclassified"}, uploaded ${cal.dstr(prior.uploaded_at)}). ` +
          `Nothing was changed. If this is a revised version the content must actually differ — re-saving the ` +
          `same file under a new name does not make it a new version. To file it against a DIFFERENT period, ` +
          `choose that period on the upload page.`,
      };
    }
  }

  const isArchived = engagement && ["archived", "locked"].includes(engagement.status);
  if (isArchived && (!additionReason || additionReason.trim().length < 10)) {
    throw new Error(
      "This engagement is archived. AS 1215.16 permits information to be ADDED after the documentation " +
        "completion date, but every addition must record the reason. Provide a reason of at least 10 characters."
    );
  }

  // ── Versioning, transactionally ──
  //
  // Read-prior, insert-new, mark-old-superseded used to be three
  // statements with no transaction and no lock. Four concurrent uploads
  // of the same category produced TWO rows at version 3, both marked
  // active and both superseding the same parent — a forked chain, which
  // is precisely the reconstruction AS 1215.06 depends on. The
  // engagement row is locked FOR UPDATE so the read and the write are
  // one atomic step per engagement, and a partial unique index on
  // (engagement_id, category_code) WHERE status='active' backs it up.
  const client = await db.connect();
  let doc, version, supersedes;
  try {
    await client.query("BEGIN");
    if (engagement) {
      await client.query(`SELECT id FROM ngtf_audit_engagements WHERE id=$1 FOR UPDATE`, [engagement.id]);
    }

    version = 1;
    supersedes = null;
    if (engagement && cls.categoryCode) {
      const prior = await client.query(
        `SELECT id, version FROM ngtf_audit_documents
          WHERE engagement_id=$1 AND category_code=$2 AND status='active'
          ORDER BY version DESC LIMIT 1`,
        [engagement.id, cls.categoryCode]
      );
      if (prior.rows.length) {
        version = prior.rows[0].version + 1;
        supersedes = prior.rows[0].id;
        // Retire the old version BEFORE inserting the new one, so the
        // partial unique index never sees two active rows at once.
        await client.query(`UPDATE ngtf_audit_documents SET status='superseded' WHERE id=$1`, [supersedes]);
      }
    }

    const ins = await client.query(
      `INSERT INTO ngtf_audit_documents
       (engagement_id, category_code, bracket_code, folder_path, filename, original_filename, mime_type,
        size_bytes, sha256, file_data, version, supersedes_id, fiscal_year, period_label, period_as_of, tier,
        classification, confidence, classify_method, needs_confirmation, brief, flags, is_confidential,
        is_gate, uploaded_by, addition_reason, addition_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     RETURNING id, filename, version, size_bytes, sha256, supersedes_id, uploaded_at, post_archive`,
    [
      engagement ? engagement.id : null,
      cls.categoryCode,
      cls.bracketCode,
      cls.folderPath,
      filename,
      filename,
      mimeType || null,
      buffer.length,
      sha256,
      buffer,
      version,
      supersedes,
      fy,
      periodLabel,
      cls.period && cls.period.asOf ? cls.period.asOf : null,
      tier,
      JSON.stringify(cls),
      cls.confidence,
      cls.method,
      !!cls.needsConfirmation,
      cls.brief,
      cls.flags && cls.flags.length ? cls.flags : null,
      !!cls.isConfidential,
      !!cls.isGate,
      user.id,
      isArchived ? additionReason : null,
      isArchived ? user.id : null,
    ]
    );
    doc = ins.rows[0];
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be gone */ }
    if (err && err.code === "23505") {
      throw new Error(
        "Another upload for this category and period completed at the same moment. Nothing was lost — " +
          "reload the engagement to see the current version, then re-send this file if it is still newer."
      );
    }
    throw err;
  } finally {
    client.release();
  }

  if (supersedes) {
    await schema.logEvent({
      documentId: supersedes,
      engagementId: engagement.id,
      event: "superseded",
      actor: user,
      detail: { bySupersedingDocument: doc.id, newVersion: version },
    });
  }

  await schema.logEvent({
    documentId: doc.id,
    engagementId: engagement ? engagement.id : null,
    event: isArchived ? "post_archive_addition" : "uploaded",
    actor: user,
    ip: req ? req.ip : null,
    userAgent: req ? req.headers["user-agent"] : null,
    detail: {
      filename,
      sha256,
      sizeBytes: buffer.length,
      category: cls.categoryCode,
      confidence: cls.confidence,
      method: cls.method,
      folderPath: cls.folderPath,
      flags: cls.flags,
      ...(isArchived ? { additionReason } : {}),
    },
  });

  // Satisfy matching open checklist items.
  const satisfied = [];
  if (engagement && cls.categoryCode) {
    const upd = await db.query(
      `UPDATE ngtf_audit_checklist_items i
          SET status='satisfied', satisfied_by_doc=$1, satisfied_at=NOW()
         FROM ngtf_audit_checklists c
        WHERE c.id = i.checklist_id
          AND c.engagement_id = $2
          AND i.kind='document'
          AND i.category_code = $3
          AND i.status='open'
        RETURNING i.id, i.label, i.is_gate`,
      [doc.id, engagement.id, cls.categoryCode]
    );
    satisfied.push(...upd.rows);
    for (const it of upd.rows) {
      await schema.logEvent({
        documentId: doc.id,
        engagementId: engagement.id,
        itemId: it.id,
        event: "checklist_item_satisfied",
        actor: user,
        detail: { label: it.label, isGate: it.is_gate },
      });
    }
  }

  // Tell the auditor what arrived, with the brief.
  try {
    await notify.notifyDocumentUploaded({
      document: doc,
      classification: cls,
      uploader: user,
      engagement,
    });
    notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
  } catch (err) {
    console.error("[ngtf-audit] upload notification failed:", err.message);
  }

  return { document: doc, classification: cls, engagement, satisfiedItems: satisfied, duplicateOf: null };
}

async function getDocument(id, { withBytes = false } = {}) {
  const cols = withBytes ? "*" : `id, engagement_id, category_code, bracket_code, folder_path, filename,
    original_filename, mime_type, size_bytes, sha256, version, supersedes_id, status, fiscal_year,
    period_label, period_as_of, tier, classification, confidence, classify_method, needs_confirmation,
    confirmed_by, confirmed_at, reclassified_from, brief, flags, is_confidential, is_gate, uploaded_by,
    uploaded_at, post_archive, addition_reason, addition_by, addition_at`;
  const r = await db.query(`SELECT ${cols} FROM ngtf_audit_documents WHERE id=$1`, [id]);
  return r.rows[0] || null;
}

async function listDocuments({ engagementId, categoryCode, bracketCode, status = "active", needsConfirmation, limit = 400 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (engagementId) add("d.engagement_id = ?", engagementId);
  if (categoryCode) add("d.category_code = ?", categoryCode);
  if (bracketCode) add("d.bracket_code = ?", bracketCode);
  if (status && status !== "all") add("d.status = ?", status);
  if (needsConfirmation) where.push("d.needs_confirmation = TRUE");
  params.push(limit);
  const r = await db.query(
    `SELECT d.id, d.filename, d.category_code, d.bracket_code, d.folder_path, d.size_bytes, d.sha256,
            d.version, d.supersedes_id, d.status, d.period_label, d.period_as_of, d.confidence,
            d.classify_method, d.needs_confirmation, d.brief, d.flags, d.is_confidential, d.is_gate,
            d.uploaded_at, d.post_archive, d.addition_reason,
            u.name AS uploaded_by_name, u.email AS uploaded_by_email,
            (SELECT COUNT(*) FROM ngtf_audit_downloads dl WHERE dl.document_id=d.id)::int AS download_count,
            (SELECT MAX(dl.downloaded_at) FROM ngtf_audit_downloads dl WHERE dl.document_id=d.id) AS last_downloaded
       FROM ngtf_audit_documents d
       LEFT JOIN ngtf_audit_users u ON u.id = d.uploaded_by
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY d.uploaded_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function recordDownload({ documentId, user, req, bytes }) {
  await db.query(
    `INSERT INTO ngtf_audit_downloads (document_id, user_id, user_email, org, ip, user_agent, bytes_sent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [documentId, user.id, user.email, user.org, req ? req.ip : null, req ? req.headers["user-agent"] : null, bytes || null]
  );
  await schema.logEvent({
    documentId,
    event: "downloaded",
    actor: user,
    ip: req ? req.ip : null,
    userAgent: req ? req.headers["user-agent"] : null,
    detail: { bytes },
  });
}

/** Correct a misclassification. Records the original for the trail. */
async function reclassify({ documentId, newCategory, user, reason }) {
  const cat = tax.CATEGORY_BY_CODE[newCategory];
  if (!cat) throw new Error(`Unknown category "${newCategory}"`);
  const doc = await getDocument(documentId);
  if (!doc) throw new Error("Document not found");
  await assertMutable(doc.engagement_id, "reclassifying a document");

  const folder = tax.folderPath(newCategory, { fiscalYear: doc.fiscal_year, periodLabel: doc.period_label });
  await db.query(
    `UPDATE ngtf_audit_documents
        SET category_code=$1, bracket_code=$2, folder_path=$3, is_gate=$4, is_confidential=$5,
            reclassified_from=COALESCE(reclassified_from, $6), needs_confirmation=FALSE,
            confirmed_by=$7, confirmed_at=NOW()
      WHERE id=$8`,
    [newCategory, cat.bracket, folder, !!cat.gate, !!cat.conf, doc.category_code, user.id, documentId]
  );
  await schema.logEvent({
    documentId,
    engagementId: doc.engagement_id,
    event: "reclassified",
    actor: user,
    detail: { from: doc.category_code, to: newCategory, reason: reason || null },
  });

  // Re-run satisfaction against the corrected category.
  if (doc.engagement_id) {
    await db.query(
      `UPDATE ngtf_audit_checklist_items i
          SET status='open', satisfied_by_doc=NULL, satisfied_at=NULL
         FROM ngtf_audit_checklists c
        WHERE c.id=i.checklist_id AND c.engagement_id=$1 AND i.satisfied_by_doc=$2`,
      [doc.engagement_id, documentId]
    );
    await db.query(
      `UPDATE ngtf_audit_checklist_items i
          SET status='satisfied', satisfied_by_doc=$1, satisfied_at=NOW()
         FROM ngtf_audit_checklists c
        WHERE c.id=i.checklist_id AND c.engagement_id=$2 AND i.kind='document'
          AND i.category_code=$3 AND i.status='open'`,
      [documentId, doc.engagement_id, newCategory]
    );
  }
  return getDocument(documentId);
}

async function confirmClassification(documentId, user) {
  const r = await db.query(
    `UPDATE ngtf_audit_documents SET needs_confirmation=FALSE, confirmed_by=$1, confirmed_at=NOW() WHERE id=$2`,
    [user.id, documentId]
  );
  // C16: reporting success for an id that does not exist wrote a
  // permanent event row about a document that was never touched.
  if (!r.rowCount) throw new Error(`Document ${documentId} not found.`);
  await schema.logEvent({ documentId, event: "classification_confirmed", actor: user });
}

// ══════════════════ CHECKLISTS ══════════════════

async function getChecklist(engagementId) {
  const cl = await db.query(`SELECT * FROM ngtf_audit_checklists WHERE engagement_id=$1 LIMIT 1`, [engagementId]);
  if (!cl.rows.length) return null;
  const items = await db.query(
    `SELECT i.*, d.filename AS doc_filename, d.version AS doc_version, d.sha256 AS doc_sha,
            u.name AS answered_by_name
       FROM ngtf_audit_checklist_items i
       LEFT JOIN ngtf_audit_documents d ON d.id = i.satisfied_by_doc
       LEFT JOIN ngtf_audit_users u ON u.id = i.answered_by
      WHERE i.checklist_id = $1
      ORDER BY i.kind DESC, i.is_gate DESC, i.category_code NULLS LAST, i.id`,
    [cl.rows[0].id]
  );
  return { ...cl.rows[0], items: items.rows };
}

async function getItem(itemId) {
  const r = await db.query(`SELECT * FROM ngtf_audit_checklist_items WHERE id=$1`, [itemId]);
  return r.rows[0] || null;
}

/**
 * Answer a sweep question. A YES spawns the document requirements
 * it implies as new checklist items; a NO is recorded as signed
 * negative assurance.
 */
async function answerSweep({ itemId, answer, note, user, supersede = false }) {
  const item = await getItem(itemId);
  if (!item) throw new Error("Checklist item not found");
  if (item.kind !== "sweep") throw new Error("That item is not a sweep question");
  await assertMutable(item.engagement_id, "changing a sweep answer");

  // C6: an answer of record should not be silently overwritable. This
  // is signed negative assurance — the module treats it as evidence, so
  // replacing it has to be deliberate and has to say why.
  if (item.status !== "open" && !supersede) {
    const prior = item.answer === true ? "YES" : item.answer === false ? "NO" : item.status;
    throw new Error(
      `This question was already answered ${prior} on ${cal.dstr(item.answered_at)}. To change it, resubmit ` +
        `with supersede set and explain what changed — the previous answer stays in the chain of custody either way.`
    );
  }

  const yes = !!answer;
  if (yes && (!note || note.trim().length < 3)) {
    throw new Error("A YES answer requires a short description of what occurred, so the auditor knows what to look for.");
  }
  if (item.status !== "open" && supersede && (!note || note.trim().length < 3)) {
    throw new Error("Changing a recorded answer requires a note explaining what changed.");
  }

  const priorAnswer = item.answer;

  await db.query(
    `UPDATE ngtf_audit_checklist_items
        SET status=$1, answer=$2, answer_note=COALESCE($3, answer_note), answered_by=$4, answered_at=NOW()
      WHERE id=$5`,
    [yes ? "answered_yes" : "answered_no", yes, note || null, user.id, itemId]
  );

  const cl = await db.query(`SELECT * FROM ngtf_audit_checklists WHERE id=$1`, [item.checklist_id]);
  const checklist = cl.rows[0];

  // C7: lead times must match the checklist's own tier. Spawned items
  // were always given QUARTERLY leads (25/18 days), so on a 10-K a YES
  // on the acquisition sweep — which spawns the six most
  // schedule-critical Rule 3-05 items on the list — dated them ~30 days
  // later than every comparable annual item.
  const leadGate = checklist.tier === "annual" ? checklists.LEAD.annual_gate : checklists.LEAD.quarterly_gate;
  const leadStd = checklist.tier === "annual" ? checklists.LEAD.annual_std : checklists.LEAD.quarterly_std;

  const spawned = [];
  const reopened = [];
  const retracted = [];

  if (yes && Array.isArray(item.spawn_codes)) {
    for (const code of item.spawn_codes) {
      const cat = tax.CATEGORY_BY_CODE[code];
      if (!cat) continue;

      const exists = await db.query(
        `SELECT id, status FROM ngtf_audit_checklist_items
          WHERE checklist_id=$1 AND category_code=$2 AND kind='document' LIMIT 1`,
        [item.checklist_id, code]
      );

      const due = checklist.filing_due_date
        ? checklists.backFrom(cal.dstr(checklist.filing_due_date), cat.gate ? leadGate : leadStd)
        : checklist.target_complete_by;

      if (exists.rows.length) {
        // C5: the previous code selected `status` and then ignored it,
        // so an item already WAIVED stayed waived. A company user could
        // pre-waive an item and the sweep meant to force it back onto
        // the list would silently do nothing.
        const row = exists.rows[0];
        if (["waived", "na"].includes(row.status)) {
          const re = await db.query(
            `UPDATE ngtf_audit_checklist_items
                SET status='open', waiver_reason=NULL, waived_by=NULL, waived_at=NULL,
                    spawned_from_item=$1, due_date=COALESCE(due_date,$2),
                    note=$3
              WHERE id=$4
              RETURNING id, label, category_code, due_date, is_gate`,
            [
              itemId,
              due,
              `Reopened because "${String(item.label).slice(0, 90)}…" was answered YES after it had been waived.`,
              row.id,
            ]
          );
          reopened.push(re.rows[0]);
        }
        continue;
      }

      const r = await db.query(
        `INSERT INTO ngtf_audit_checklist_items
           (checklist_id, engagement_id, kind, category_code, bracket_code, label, authority, note,
            owner_role, due_date, is_gate, spawned_from_item)
         VALUES ($1,$2,'document',$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, label, category_code, due_date, is_gate`,
        [
          item.checklist_id,
          item.engagement_id,
          code,
          cat.bracket,
          cat.label,
          cat.authority || null,
          `Required because "${String(item.label).slice(0, 90)}…" was answered YES.`,
          cat.owner || null,
          due,
          !!cat.gate,
          itemId,
        ]
      );
      spawned.push(r.rows[0]);
    }
    await reconcileChecklist(item.checklist_id);
  }

  // C4: a YES→NO reversal used to leave its spawned items sitting open
  // with a note saying they were required because the question was
  // answered YES — attached to a question that now says nothing
  // happened. Close them, and say why.
  if (!yes && priorAnswer === true) {
    const closed = await db.query(
      `UPDATE ngtf_audit_checklist_items
          SET status='na',
              note = COALESCE(note,'') || ' — no longer required: the sweep answer was changed to NO on ' || to_char(NOW(),'YYYY-MM-DD') || '.'
        WHERE spawned_from_item=$1 AND status='open'
        RETURNING id, category_code, label`,
      [itemId]
    );
    retracted.push(...closed.rows);
  }

  await schema.logEvent({
    engagementId: item.engagement_id,
    itemId,
    event: yes ? "sweep_answered_yes" : "sweep_answered_no",
    actor: user,
    detail: {
      sweepId: item.sweep_id,
      note: note || null,
      supersededPriorAnswer: item.status !== "open" ? priorAnswer : undefined,
      spawned: spawned.map((x) => x.category_code),
      reopened: reopened.map((x) => x.category_code),
      retracted: retracted.map((x) => x.category_code),
    },
  });

  const added = spawned.concat(reopened);
  if (yes && added.length) {
    const eng = await getEngagement(item.engagement_id);
    try {
      await notify.notifySweepYes({
        item,
        answerNote: note,
        spawned: added.map((x) => x.category_code),
        user,
        engagement: eng,
      });
      notify.flush().catch((e) => console.error("[ngtf-audit] flush:", e.message));
    } catch (err) {
      console.error("[ngtf-audit] sweep notification failed:", err.message);
    }
  }

  return { item: await getItem(itemId), spawned, reopened, retracted };
}

async function waiveItem({ itemId, reason, user }) {
  if (!reason || reason.trim().length < 10) {
    throw new Error(
      "A waiver needs a substantive reason of at least 10 characters — the auditor will read it, and " +
        "AS 1301.25 requires difficulties in obtaining information to be reported to the audit committee."
    );
  }
  const item = await getItem(itemId);
  if (!item) throw new Error("Item not found");
  await assertMutable(item.engagement_id, "waiving an item");
  if (item.is_gate) {
    throw new Error(
      "Gating items cannot be waived from the company side. A gating item is one where a standard or rule " +
        "prevents the report or filing from issuing without it. Raise it with the engagement partner instead."
    );
  }
  await db.query(
    `UPDATE ngtf_audit_checklist_items SET status='waived', waiver_reason=$1, waived_by=$2, waived_at=NOW() WHERE id=$3`,
    [reason, user.id, itemId]
  );
  await schema.logEvent({ engagementId: item.engagement_id, itemId, event: "item_waived", actor: user, detail: { reason } });
  return getItem(itemId);
}

/** Auditor accepts a delivered item (PBC sign-off). */
async function acceptItem({ itemId, user }) {
  const item = await getItem(itemId);
  if (!item) throw new Error("Item not found");
  await assertMutable(item.engagement_id, "accepting an item");
  await db.query(
    `UPDATE ngtf_audit_checklist_items
        SET auditor_accepted=TRUE, auditor_accepted_by=$1, auditor_accepted_at=NOW() WHERE id=$2`,
    [user.id, itemId]
  );
  await schema.logEvent({ engagementId: item.engagement_id, itemId, event: "item_accepted_by_auditor", actor: user });
  return getItem(itemId);
}

/** Auditor rejects a delivered item → reopens it and notifies. */
async function rejectItem({ itemId, reason, user }) {
  const item = await getItem(itemId);
  if (!item) throw new Error("Item not found");
  await assertMutable(item.engagement_id, "reopening an item");
  await db.query(
    `UPDATE ngtf_audit_checklist_items
        SET status='open', satisfied_by_doc=NULL, satisfied_at=NULL, auditor_accepted=FALSE WHERE id=$1`,
    [itemId]
  );
  const cm = await addComment({
    itemId,
    documentId: item.satisfied_by_doc,
    engagementId: item.engagement_id,
    body: reason,
    kind: "review_note",
    user,
  });
  await schema.logEvent({ engagementId: item.engagement_id, itemId, event: "item_rejected_by_auditor", actor: user, detail: { reason } });
  return { item: await getItem(itemId), comment: cm };
}

// ══════════════════ COMMENTS / REVIEW NOTES ══════════════════

async function addComment({ documentId, itemId, engagementId, parentId, body, kind = "comment", user }) {
  if (!body || !body.trim()) throw new Error("Comment body is required");
  const r = await db.query(
    `INSERT INTO ngtf_audit_comments (document_id, item_id, engagement_id, parent_id, author_id, body, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [documentId || null, itemId || null, engagementId || null, parentId || null, user.id, body.trim(), kind]
  );
  const comment = r.rows[0];
  await schema.logEvent({ documentId, engagementId, itemId, event: "comment_added", actor: user, detail: { kind } });

  // An auditor note needs the company to see it now.
  if (user.org === "auditor") {
    try {
      const doc = documentId ? await getDocument(documentId) : null;
      const item = itemId ? await getItem(itemId) : null;
      const eng = engagementId ? await getEngagement(engagementId) : doc ? await getEngagement(doc.engagement_id) : null;
      await notify.notifyReviewNote({ comment, document: doc, item, author: user, engagement: eng });
      notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
    } catch (err) {
      console.error("[ngtf-audit] review note notification failed:", err.message);
    }
  }
  return comment;
}

async function listComments({ documentId, itemId, engagementId, openOnly = false }) {
  const where = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (documentId) add("c.document_id = ?", documentId);
  if (itemId) add("c.item_id = ?", itemId);
  if (engagementId) add("c.engagement_id = ?", engagementId);
  if (openOnly) where.push("c.resolved = FALSE");
  const r = await db.query(
    `SELECT c.*, u.name AS author_name, u.org AS author_org, u.firm_name AS author_firm
       FROM ngtf_audit_comments c LEFT JOIN ngtf_audit_users u ON u.id=c.author_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY c.created_at ASC`,
    params
  );
  return r.rows;
}

async function resolveComment(id, user) {
  const r = await db.query(
    `UPDATE ngtf_audit_comments SET resolved=TRUE, resolved_by=$1, resolved_at=NOW() WHERE id=$2 AND resolved=FALSE`,
    [user.id, id]
  );
  if (!r.rowCount) throw new Error(`Comment ${id} not found, or already resolved.`);
  await schema.logEvent({ event: "comment_resolved", actor: user, detail: { commentId: id } });
}

// ══════════════════ DASHBOARD AGGREGATION ══════════════════

async function dashboard() {
  const engagements = await listEngagements({ limit: 12 });
  const triage = await db.query(
    `SELECT COUNT(*)::int AS n FROM ngtf_audit_documents WHERE needs_confirmation = TRUE AND status='active'`
  );
  const recent = await db.query(
    `SELECT d.id, d.filename, d.category_code, d.brief, d.uploaded_at, d.version, d.is_gate, d.confidence,
            u.name AS uploaded_by_name
       FROM ngtf_audit_documents d LEFT JOIN ngtf_audit_users u ON u.id=d.uploaded_by
      WHERE d.status='active' ORDER BY d.uploaded_at DESC LIMIT 12`
  );
  const overdue = await db.query(
    `SELECT i.id, i.label, i.category_code, i.due_date, i.is_gate, c.period_label, c.engagement_id
       FROM ngtf_audit_checklist_items i JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
      WHERE i.status='open' AND i.due_date < CURRENT_DATE
      ORDER BY i.is_gate DESC, i.due_date ASC LIMIT 20`
  );
  const notes = await db.query(
    `SELECT c.id, c.body, c.created_at, c.document_id, c.item_id, u.name AS author_name, u.org AS author_org
       FROM ngtf_audit_comments c LEFT JOIN ngtf_audit_users u ON u.id=c.author_id
      WHERE c.resolved=FALSE ORDER BY c.created_at DESC LIMIT 12`
  );
  const upcoming = await db.query(
    `SELECT id, period_label, period_name, filing_form, filing_due_date, filing_nt_due_date, status
       FROM ngtf_audit_engagements
      WHERE filing_due_date IS NOT NULL AND filed_on IS NULL AND filing_due_date >= CURRENT_DATE
      ORDER BY filing_due_date ASC LIMIT 5`
  );
  const archiveClocks = [];
  const rel = await db.query(
    `SELECT id, period_label, report_release_date, doc_completion_date, status
       FROM ngtf_audit_engagements
      WHERE report_release_date IS NOT NULL AND status NOT IN ('locked')
      ORDER BY report_release_date DESC LIMIT 5`
  );
  for (const e of rel.rows) {
    const cd = cal.archiveCountdown(cal.dstr(e.report_release_date));
    if (cd) archiveClocks.push({ ...e, ...cd });
  }

  return {
    engagements,
    triageCount: triage.rows[0].n,
    recentUploads: recent.rows,
    overdue: overdue.rows,
    openNotes: notes.rows,
    upcomingFilings: upcoming.rows,
    archiveClocks,
    stats: tax.STATS,
  };
}

/** Per-bracket completion for the current engagement view. */
async function bracketProgress(engagementId) {
  const r = await db.query(
    `SELECT i.bracket_code,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE i.status IN ('satisfied','answered_no','waived','na'))::int AS done,
            COUNT(*) FILTER (WHERE i.status='open' AND i.is_gate)::int AS open_gates,
            COUNT(*) FILTER (WHERE i.status='open' AND i.due_date < CURRENT_DATE)::int AS overdue
       FROM ngtf_audit_checklist_items i
       JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
      WHERE c.engagement_id=$1 AND i.bracket_code IS NOT NULL
      GROUP BY i.bracket_code ORDER BY i.bracket_code`,
    [engagementId]
  );
  return r.rows;
}

async function events({ documentId, engagementId, limit = 200 }) {
  const where = [];
  const params = [];
  if (documentId) {
    params.push(documentId);
    where.push(`document_id = $${params.length}`);
  }
  if (engagementId) {
    params.push(engagementId);
    where.push(`engagement_id = $${params.length}`);
  }
  params.push(limit);
  const r = await db.query(
    `SELECT * FROM ngtf_audit_events ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

module.exports = {
  assertMutable,
  // engagements
  getEngagement,
  findEngagement,
  listEngagements,
  openEngagement,
  ensureChecklist,
  reconcileChecklist,
  setReportReleaseDate,
  archiveEngagement,
  setLegalHold,
  // documents
  ingestDocument,
  getDocument,
  listDocuments,
  recordDownload,
  reclassify,
  confirmClassification,
  // checklists
  getChecklist,
  getItem,
  answerSweep,
  waiveItem,
  acceptItem,
  rejectItem,
  // comments
  addComment,
  listComments,
  resolveComment,
  // views
  dashboard,
  bracketProgress,
  events,
};
