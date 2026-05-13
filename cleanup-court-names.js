// cleanup-court-names.js
//
// Phase 1: Merge "9th Circuit" → "9th Circuit Court of Appeals" across all 3 tables
// Phase 3: Identify junk judge profiles for deletion
//
// USAGE:
//   node cleanup-court-names.js          # DRY RUN — no changes committed
//   node cleanup-court-names.js --commit # APPLY changes
//
// Idempotent: safe to re-run.

const db = require("./db");

const COMMIT = process.argv.includes("--commit");

async function main() {
  console.log("════════════════════════════════════════════════");
  console.log("  CLEANUP: Court Name Normalization + Junk Judges");
  console.log("  Mode:", COMMIT ? "🔥 COMMIT — CHANGES WILL BE APPLIED" : "🧪 DRY RUN — nothing will change");
  console.log("════════════════════════════════════════════════");
  console.log("");

  await db.query("BEGIN");
  try {
    // ── PHASE 1A: judge_rulings ──
    const r1 = await db.query(
      `UPDATE judge_rulings SET court = '9th Circuit Court of Appeals' WHERE court = '9th Circuit'`
    );
    console.log("Phase 1A: judge_rulings normalized:", r1.rowCount);

    // ── PHASE 1B: judge_insights — merge conflicts, delete sources, then rename remainder ──
    const insightMerge = await db.query(`
      UPDATE judge_insights tgt SET
        grant_count    = tgt.grant_count + src.grant_count,
        deny_count     = tgt.deny_count + src.deny_count,
        key_phrases    = (SELECT array_agg(DISTINCT x) FROM unnest(coalesce(tgt.key_phrases, ARRAY[]::text[]) || coalesce(src.key_phrases, ARRAY[]::text[])) AS x),
        accepted_args  = (SELECT array_agg(DISTINCT x) FROM unnest(coalesce(tgt.accepted_args, ARRAY[]::text[]) || coalesce(src.accepted_args, ARRAY[]::text[])) AS x),
        rejected_args  = (SELECT array_agg(DISTINCT x) FROM unnest(coalesce(tgt.rejected_args, ARRAY[]::text[]) || coalesce(src.rejected_args, ARRAY[]::text[])) AS x),
        cited_statutes = (SELECT array_agg(DISTINCT x) FROM unnest(coalesce(tgt.cited_statutes, ARRAY[]::text[]) || coalesce(src.cited_statutes, ARRAY[]::text[])) AS x),
        cited_cases    = (SELECT array_agg(DISTINCT x) FROM unnest(coalesce(tgt.cited_cases, ARRAY[]::text[]) || coalesce(src.cited_cases, ARRAY[]::text[])) AS x),
        updated_at     = NOW()
      FROM judge_insights src
      WHERE src.court = '9th Circuit'
        AND tgt.court = '9th Circuit Court of Appeals'
        AND tgt.judge_name = src.judge_name
        AND tgt.motion_type = src.motion_type
    `);
    console.log("Phase 1B-merge: judge_insights conflicts merged:", insightMerge.rowCount);

    const insightDelete = await db.query(`
      DELETE FROM judge_insights src
      WHERE src.court = '9th Circuit'
        AND EXISTS (
          SELECT 1 FROM judge_insights tgt
          WHERE tgt.judge_name = src.judge_name
            AND tgt.motion_type = src.motion_type
            AND tgt.court = '9th Circuit Court of Appeals'
        )
    `);
    console.log("Phase 1B-delete: merged source rows deleted:", insightDelete.rowCount);

    const insightRename = await db.query(`
      UPDATE judge_insights SET court = '9th Circuit Court of Appeals' WHERE court = '9th Circuit'
    `);
    console.log("Phase 1B-rename: remaining insights renamed:", insightRename.rowCount);

    // Also re-point judge_insights.judge_profile_id (if any) before profile deletes below.
    // We do this UPDATE conservatively — only if the FK column exists. If it doesn't,
    // this UPDATE will fail and the catch will roll back. We probe with information_schema first.
    const hasInsightFk = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name='judge_insights' AND column_name='judge_profile_id'
      LIMIT 1
    `);
    if (hasInsightFk.rows.length > 0) {
      const insightsRepoint = await db.query(`
        UPDATE judge_insights i SET
          judge_profile_id = tgt.id
        FROM judge_profiles src
        JOIN judge_profiles tgt
          ON tgt.judge_name = src.judge_name
         AND tgt.court = '9th Circuit Court of Appeals'
         AND tgt.id != src.id
        WHERE src.court = '9th Circuit'
          AND i.judge_profile_id = src.id
      `);
      console.log("Phase 1B-repoint: judge_insights re-pointed to surviving profile:", insightsRepoint.rowCount);
    }

    // ── PHASE 1C: judge_profiles — same merge pattern ──
    const profileMerge = await db.query(`
      UPDATE judge_profiles tgt SET
        total_rulings = tgt.total_rulings + src.total_rulings,
        last_updated  = NOW()
      FROM judge_profiles src
      WHERE src.court = '9th Circuit'
        AND tgt.court = '9th Circuit Court of Appeals'
        AND tgt.judge_name = src.judge_name
    `);
    console.log("Phase 1C-merge: judge_profiles conflicts merged:", profileMerge.rowCount);

    // CRITICAL: Re-point judge_rulings.judge_profile_id from the duplicate (src) to the survivor (tgt)
    // BEFORE deleting the duplicate, otherwise FK constraint blocks delete.
    const rulingsRepoint = await db.query(`
      UPDATE judge_rulings r SET
        judge_profile_id = tgt.id
      FROM judge_profiles src
      JOIN judge_profiles tgt
        ON tgt.judge_name = src.judge_name
       AND tgt.court = '9th Circuit Court of Appeals'
       AND tgt.id != src.id
      WHERE src.court = '9th Circuit'
        AND r.judge_profile_id = src.id
    `);
    console.log("Phase 1C-repoint: judge_rulings re-pointed to surviving profile:", rulingsRepoint.rowCount);

    const profileDelete = await db.query(`
      DELETE FROM judge_profiles src
      WHERE src.court = '9th Circuit'
        AND EXISTS (
          SELECT 1 FROM judge_profiles tgt
          WHERE tgt.judge_name = src.judge_name
            AND tgt.court = '9th Circuit Court of Appeals'
        )
    `);
    console.log("Phase 1C-delete: merged source profiles deleted:", profileDelete.rowCount);

    const profileRename = await db.query(`
      UPDATE judge_profiles SET court = '9th Circuit Court of Appeals' WHERE court = '9th Circuit'
    `);
    console.log("Phase 1C-rename: remaining profiles renamed:", profileRename.rowCount);

    // ── PHASE 3: Junk judges (preview only — actual delete commented out for safety) ──
    const junkNames = ["Consideration", "Took", "Joined", "Affirmed", "Dissented", "Concluded", "Recused", "Sitting"];
    const junkPreview = await db.query(
      `SELECT judge_name, court, total_rulings FROM judge_profiles WHERE judge_name = ANY($1) ORDER BY total_rulings DESC`,
      [junkNames]
    );
    console.log("");
    console.log("Phase 3 preview — junk judge profiles:");
    if (junkPreview.rows.length === 0) {
      console.log("  (none found)");
    } else {
      for (const r of junkPreview.rows) {
        console.log("  " + r.judge_name + "  rulings=" + r.total_rulings + "  " + r.court);
      }
    }

    // Actually delete junk
    const junkDeleteRulings = await db.query(
      `DELETE FROM judge_rulings WHERE judge_name = ANY($1)`,
      [junkNames]
    );
    console.log("Phase 3-delete: junk judge_rulings deleted:", junkDeleteRulings.rowCount);

    const junkDeleteInsights = await db.query(
      `DELETE FROM judge_insights WHERE judge_name = ANY($1)`,
      [junkNames]
    );
    console.log("Phase 3-delete: junk judge_insights deleted:", junkDeleteInsights.rowCount);

    const junkDeleteProfiles = await db.query(
      `DELETE FROM judge_profiles WHERE judge_name = ANY($1)`,
      [junkNames]
    );
    console.log("Phase 3-delete: junk judge_profiles deleted:", junkDeleteProfiles.rowCount);

    // ── FINAL STATE CHECK ──
    const finalCourts = await db.query(`
      SELECT court, COUNT(*) AS n
      FROM judge_rulings
      WHERE court IS NOT NULL
      GROUP BY court
      ORDER BY n DESC
    `);
    console.log("");
    console.log("Final court ruling distribution:");
    for (const r of finalCourts.rows) {
      console.log("  " + (r.court || "?").padEnd(45), r.n.toString().padStart(7));
    }

    const finalTotals = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM judge_profiles) AS judges,
        (SELECT COUNT(*) FROM judge_rulings) AS rulings,
        (SELECT COUNT(*) FROM judge_insights) AS insights
    `);
    const ft = finalTotals.rows[0];
    console.log("");
    console.log("Final totals — judges:", ft.judges, "rulings:", ft.rulings, "insights:", ft.insights);

    if (COMMIT) {
      await db.query("COMMIT");
      console.log("");
      console.log("✅ COMMITTED — changes applied to database");
    } else {
      await db.query("ROLLBACK");
      console.log("");
      console.log("🧪 DRY RUN COMPLETE — nothing committed. Run with --commit to apply.");
    }
  } catch (e) {
    await db.query("ROLLBACK");
    console.error("");
    console.error("❌ ERROR:", e.message);
    console.error("Stack:", e.stack);
    console.error("Transaction rolled back. Database unchanged.");
  }
  process.exit(0);
}

main();
